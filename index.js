require('dotenv').config();
const express = require('express');
const { XMLParser } = require('fast-xml-parser');
const { MongoClient } = require('mongodb');
const basicAuth = require('express-basic-auth');
const pubSubHubbub = require('./pubsubhubbub');
const logger = require('./logger');

const fetch = (...args) => import('node-fetch').then(({ default: fetch2 }) => fetch2(...args));

const app = express();

const PORT = 1337;
const PATH = '/hubbub';
const {
  MONGODB_URL, YOUTUBE_KEY, HOST, SECRET,
} = process.env;

const pubsub = pubSubHubbub.createServer({
  callbackUrl: `https://${HOST}${PATH}`,
  secret: SECRET,
});

const mapaCanales = {};

const hub = 'https://pubsubhubbub.appspot.com/';

app.use(
  PATH,
  pubsub.listener(),
);

// default response
app.get('/', (req, res) => {
  res.send('hello world');
});

const authMiddleware = basicAuth({
  challenge: true,
  users: {
    admin: SECRET,
  },
});
app.get(
  '/api/status',
  authMiddleware,
  (req, res) => {
    res.json(mapaCanales);
  },
);

app.get('/api/active', authMiddleware, (req, res) => {
  res.json(Object.values(mapaCanales).filter(({ subscribed }) => subscribed));
});

app.get('/api/inactive', authMiddleware, (req, res) => {
  res.json(Object.values(mapaCanales).filter(({ subscribed }) => !subscribed));
});

app.listen(PORT, () => {
  logger.info('Server listening on port %s', PORT);
});

pubsub.on('denied', (data) => {
  logger.info({
    message: 'Denied',
    data,
  });
});

pubsub.on('subscribe', (data) => {
  logger.info({
    message: 'Subscribe',
    data,
  });
  const channelId = data.topic.slice(-24);
  mapaCanales[channelId].lease = data.lease * 1000;
  mapaCanales[channelId].subscribed = true;
  mapaCanales[channelId].subscribeDate = new Date().getTime();
});

pubsub.on('unsubscribe', (data) => {
  logger.info({
    message: 'Unsubscribe',
    data,
  });
});

pubsub.on('error', (error) => {
  logger.error({
    message: 'pubSubError',
    errormsg: error.message,
    errorStack: error.stack,
  });
});

const parser = new XMLParser();

const client = new MongoClient(MONGODB_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

function subscribe(canal) {
  logger.debug({
    message: 'subscribe',
    canal,
  });
  pubsub.subscribe(
    `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${canal}`,
    hub,
  );
}

// every hour check for subscriptions about to expire within the day
setInterval(() => {
  Object.values(mapaCanales).forEach((canal, ind) => {
    try {
      if (canal.subscribed) {
        const now = new Date().getTime();
        const diff = now - canal.subscribeDate;
        if (diff + (24 * 60 * 60 * 1000) > canal.lease) {
          logger.info({
            message: 'Renewing subscription',
            canal,
          });
          setTimeout(() => {
            try {
              subscribe(canal.id)
            } catch (error) {
              logger.error({
                message: 'Error renewing subscription',
                canal,
              });
            }
          }, ind * 1000);
        }
        if (diff > canal.lease) {
          logger.info({
            message: 'Subscription expired',
            canal,
          });
          // eslint-disable-next-line no-param-reassign
          canal.subscribed = false;
        }
      }
    } catch (error) {
      logger.error({
        message: 'Error checking subscription',
        canal,
      });
    }
  });
}, 1000 * 60 * 60);

(async function init() {
  try {
    await client.connect();
    const db = client.db('yt');
    const agregaVideoAMongo = (videoObj) => db
      .collection('videos')
      .findOneAndUpdate(
        { _id: videoObj.id },
        { $setOnInsert: videoObj },
        { upsert: true, returnDocument: 'after' },
      );
    pubsub.on('feed', async (data) => {
      try {
        const jsonObj = parser.parse(data.feed.toString());
        const videoId = jsonObj.feed.entry['yt:videoId'];
        const channelId = jsonObj.feed.entry['yt:channelId'];
        const { title, published, updated } = jsonObj.feed.entry;
        logger.info({
          message: 'videoFeed',
          videoId,
          title,
          published,
          updated,
          channelId,
        });
        if (channelId in mapaCanales) {
          mapaCanales[channelId].msgCount += 1;
          mapaCanales[channelId].lastMsg = new Date().getTime();
          mapaCanales[channelId].lastMsgVideo = videoId;
        }
        const infoURL = new URL(
          'https://www.googleapis.com/youtube/v3/videos',
        );
        infoURL.searchParams.append('id', videoId);
        infoURL.searchParams.append('key', YOUTUBE_KEY);
        infoURL.searchParams.append('part', 'contentDetails,snippet,status');
        infoURL.searchParams.append('hl', 'en');
        const resp = await fetch(infoURL);
        const respObj = await resp.json();
        const [videoInfo] = respObj.items;

        videoInfo.descargado = false;
        videoInfo.descargando = false;
        if (
          videoInfo.status.uploadStatus === 'uploaded'
            && videoInfo.snippet.liveBroadcastContent === 'live'
        ) {
          videoInfo.live = true;
        }
        videoInfo.dateAdded = new Date().toISOString();
        videoInfo.pubsub = true;
        // agregarlo a la base de datos si no esta
        await agregaVideoAMongo(videoInfo);
      } catch (error) {
        logger.error({
          message: 'feedError',
          errormsg: error.message,
          errorStack: error.stack,
        });
      }
    });
    const doc = await db
      .collection('canales')
      .find({ activo: true })
      .project({ id: 1, 'snippet.title': 1, _id: 0 })
      .toArray();
    // TODO: comment next line when done
    doc.splice(1);
    doc.forEach((canal) => {
      mapaCanales[canal.id] = {
        ...canal,
        subscribed: false,
        msgCount: 0,
      };
    });
    doc.forEach((canal, y) => {
      setTimeout(() => {
        subscribe(canal.id);
      }, y * 1000);
    });
    logger.silly({ message: 'Connected to MongoDB' });
  } catch (error) {
    logger.error({
      message: 'MongoDBError',
      errormsg: error.message,
      errorStack: error.stack,
    });
  }
}());
