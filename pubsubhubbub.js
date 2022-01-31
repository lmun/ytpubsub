/* eslint-disable no-param-reassign */
/* eslint-disable no-underscore-dangle */

const http = require('http');
const urllib = require('url');
const { Stream } = require('stream');
const crypto = require('crypto');
const logger = require('./logger');

const fetch = (...args) => import('node-fetch').then(({ default: fetch2 }) => fetch2(...args));

/**
 * Create a PubSubHubbub client handler object. HTTP server is set up to listen
 * the responses from the hubs.
 *
 * @constructor
 * @param {Object} [options] Options object
 * @param {String} [options.callbackUrl] Callback URL for the hub
 * @param {String} [options.secret] Secret value for HMAC signatures
 * @param {Number} [options.maxContentSize] Maximum allowed size of the POST messages
 * @param {String} [options.username] Username for HTTP Authentication
 * @param {String} [options.password] Password for HTTP Authentication
 * @param {String} [headers] Custom headers to use for all HTTP requests
 */
class PubSubHubbub extends Stream {
  constructor(options) {
    super();

    options = options || {};

    this.headers = options.headers || {};
    this.secret = options.secret || false;
    this.leaseSeconds = Number(options.leaseSeconds) || 0;

    this.callbackUrl = options.callbackUrl || '';
    this.maxContentSize = options.maxContentSize || 3 * 1024 * 1024;
  }

  // PUBLIC API

  /**
   * Creates an Express middleware handler for PubSubHubbub
   *
   * @param  {Object}   req HTTP request object
   * @param  {Object}   res HTTP response object
   * @param  {Function} next Optional connect middleware next()
   * @return {Function} Middleware handler
   */
  listener() {
    return (req, res, next) => {
      this._onRequest(req, res, next);
    };
  }

  /**
   * Start listening on selected port
   *
   * Uses the same arguments as http#listen (port, host, callback)
   */
  listen(...args) {
    [this.port] = args;

    this.server = http.createServer(this._onRequest.bind(this));
    this.server.on('error', this._onError.bind(this));
    this.server.on('listening', this._onListening.bind(this));

    this.server.listen(...args);
  }

  /**
   * Subsribe for a topic at selected hub
   *
   * @param {String} topic Atom or RSS feed URL
   * @param {String} hub Hub URL
   * @param {String} [callbackUrl] Define callback url for the hub, do not use the default
   * @param {Function} [callback] Callback function, might not be very useful
   */
  subscribe(topic, hub, callbackUrl, callback) {
    this.setSubscription('subscribe', topic, hub, callbackUrl, callback);
  }

  /**
   * Unsubsribe a topic at selected hub
   *
   * @param {String} topic Atom or RSS feed URL
   * @param {String} hub Hub URL
   * @param {String} [callbackUrl] Define callback url for the hub, do not use the default
   * @param {Function} [callback] Callback function, might not be very useful
   */
  unsubscribe(topic, hub, callbackUrl, callback) {
    this.setSubscription('unsubscribe', topic, hub, callbackUrl, callback);
  }

  /**
   * Subsribe or unsubscribe a topic at selected hub
   *
   * @param {String} mode Either 'subscribe' or 'unsubscribe'
   * @param {String} topic Atom or RSS feed URL
   * @param {String} hub Hub URL
   * @param {String} [callbackUrl] Define callback url for the hub, do not use the default
   */
  setSubscription(mode, topic, hub, callbackUrl) {
    // by default the topic url is added as a GET parameter to the callback url
    callbackUrl = callbackUrl
      || `${this.callbackUrl
        + (this.callbackUrl.replace(/^https?:\/\//i, '').match(/\//) ? '' : '/')
        + (this.callbackUrl.match(/\?/) ? '&' : '?')
      }topic=${
        encodeURIComponent(topic)
      }&hub=${
        encodeURIComponent(hub)}`;

    const formParams = new URLSearchParams();
    formParams.append('hub.callback', callbackUrl);
    formParams.append('hub.mode', mode);
    formParams.append('hub.topic', topic);
    formParams.append('hub.verify', 'async');

    if (this.leaseSeconds > 0) {
      formParams.append('hub.lease_seconds', this.leaseSeconds);
    }

    if (this.secret) {
      // do not use the original secret but a generated one
      formParams.append('hub.secret', crypto
        .createHmac('sha1', this.secret)
        .update(topic)
        .digest('hex'));
    }

    fetch(hub, {
      method: 'POST',
      body: formParams,
      headers: this.headers,
    }).then((response) => {
      if (response.status !== 202 && response.status !== 204) {
        return Promise.reject(new Error(`Invalid response status ${response.status}`));
      }
      return undefined;
    }).catch((err) => {
      this.emit('denied', {
        topic,
        error: err,
      });
    });
  }

  // PRIVATE API

  /**
   * Request handler. Will be fired when a client (hub) opens a connection to the server
   *
   * @event
   * @param {Object} req HTTP Request object
   * @param {Object} res HTTP Response object
   * @param {Function} next Optional connect middleware next()
   */
  _onRequest(req, res, next) {
    switch (req.method) {
      case 'GET':
        return this._onGetRequest(req, res, next);
      case 'POST':
        return this._onPostRequest(req, res, next);
      default:
        return this._sendError(req, res, next, 405, 'Method Not Allowed');
    }
  }

  /**
   * Error event handler for the HTTP server
   *
   * @event
   * @param {Error} error Error object
   */
  _onError(error) {
    if (error.syscall === 'listen') {
      error.message = `Failed to start listening on port ${
        this.port
      } (${
        error.code
      })`;
      this.emit('error', error);
    } else {
      this.emit('error', error);
    }
  }

  /**
   * Will be fired when HTTP server has successfully started listening on the selected port
   *
   * @event
   */
  _onListening() {
    this.emit('listen');
  }

  /**
   * GET request handler for the HTTP server. This should be called when the server
   * tries to verify the intent of the subscriber.
   *
   * @param {Object} req HTTP Request object
   * @param {Object} res HTTP Response object
   * @param {Function} next Optional connect middleware next()
   */
  _onGetRequest(req, res, next) {
    const params = urllib.parse(req.url, true, true);
    let data;

    // Does not seem to be a valid PubSubHubbub request
    if (!params.query['hub.topic'] || !params.query['hub.mode']) {
      return this._sendError(req, res, next, 400, 'Bad Request');
    }

    switch (params.query['hub.mode']) {
      case 'denied':
        data = {
          topic: params.query['hub.topic'],
          hub: params.query.hub,
        };
        if (next) {
          res.statusCode = 200;
          res.set('Content-Type', 'text/plain');
          res.send(params.query['hub.challenge'] || 'ok');
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
          });
          res.end(params.query['hub.challenge'] || 'ok');
        }
        break;
      case 'subscribe':
      case 'unsubscribe':
        data = {
          lease:
            Number(params.query['hub.lease_seconds'] || 0),
          topic: params.query['hub.topic'],
          hub: params.query.hub,
        };
        if (next) {
          res.statusCode = 200;
          res.set('Content-Type', 'text/plain');
          res.send(params.query['hub.challenge']);
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/plain',
          });
          res.end(params.query['hub.challenge']);
        }
        break;
      default:
        // Not a valid mode
        return this._sendError(req, res, next, 403, 'Forbidden');
    }

    // Emit subscription information
    this.emit(params.query['hub.mode'], data);
    return undefined;
  }

  /**
   * POST request handler. Should be called when the hub tries to notify the subscriber
   * with new data
   *
   * @param {Object} req HTTP Request object
   * @param {Object} res HTTP Response object
   * @param {Function} next Optional connect middleware next()
   */
  _onPostRequest(req, res, next) {
    const bodyChunks = [];
    const params = urllib.parse(req.url, true, true);
    let topic = params && params.query && params.query.topic;
    let hub = params && params.query && params.query.hub;
    let bodyLen = 0;
    let tooLarge = false;
    let signatureParts;
    let algo;
    let signature;
    let hmac;

    const setTopicHub = (o, url, rel) => {
      rel = rel || '';

      switch (rel.toLowerCase()) {
        case 'self':
          topic = url;
          break;
        case 'hub':
          hub = url;
          break;
        default:
          break;
      }
    };

    // v0.4 hubs have a link header that includes both the topic url and hub url
    const regex = /<([^>]+)>;\s*rel=(?:["'](?=.*["']))?([A-z]+)/gi;
    const requestLink = (req.headers && req.headers.link) || '';
    const requestRels = regex.exec(requestLink);
    if (!requestRels) {
      return this._sendError(req, res, next, 400, 'Bad Request');
    }

    setTopicHub(...requestRels);
    logger.info({
      message: 'Received POST request',
      topic,
      hub,
    });

    if (!topic) {
      return this._sendError(req, res, next, 400, 'Bad Request');
    }

    // Hub must notify with signature header if secret specified.
    if (this.secret && !req.headers['x-hub-signature']) {
      return this._sendError(req, res, next, 403, 'Forbidden');
    }

    if (this.secret) {
      signatureParts = req.headers['x-hub-signature'].split('=');
      algo = (signatureParts.shift() || '').toLowerCase();
      signature = (signatureParts.pop() || '').toLowerCase();

      try {
        hmac = crypto.createHmac(
          algo,
          crypto.createHmac('sha1', this.secret).update(topic).digest('hex'),
        );
      } catch (E) {
        return this._sendError(req, res, next, 403, 'Forbidden');
      }
    }

    req.on('readable', () => {
      if (tooLarge) {
        return;
      }
      let chunk = req.read();
      while (chunk !== null) {
        if (bodyLen + chunk.length <= this.maxContentSize) {
          bodyChunks.push(chunk);
          bodyLen += chunk.length;
          if (this.secret) {
            hmac.update(chunk);
          }
        } else {
          tooLarge = true;
        }
        chunk = req.read();
      }
    });

    req.on('end', () => {
      if (tooLarge) {
        return this._sendError(req, res, next, 413, 'Request Entity Too Large');
      }
      const resu = hmac.digest('hex').toLowerCase();
      // Must return 2xx code even if signature doesn't match.
      if (this.secret && resu !== signature) {
        logger.warn({
          message: 'Invalid signature',
        });
        if (next) {
          // express
          res.statusCode = 202;
          res.set('Content-Type', 'text/plain; charset=utf-8');
          return res.send('');
        }
        // http
        res.writeHead(202, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        return res.end();
      }

      if (next) {
        // express
        res.statusCode = 204;
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send('');
      } else {
        // http
        res.writeHead(204, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end();
      }
      logger.info({
        message: 'Valid subscription notification',
        topic,
        hub,
      });
      this.emit('feed', {
        topic,
        hub,
        callback: `http://${req.headers.host}${req.url}`,
        feed: Buffer.concat(bodyChunks, bodyLen),
        headers: req.headers,
      });
      return undefined;
    });
    return undefined;
  }

  /**
   * Generates and sends an error message as the response for a HTTP request
   *
   * @param {Object} req HTTP Request object
   * @param {Object} res HTTP Response object
   * @param {Function} next Optional connect middleware next()
   * @param {Number} code HTTP response status
   * @param {String} message Error message to display
   */
  // eslint-disable-next-line class-methods-use-this
  _sendError(req, res, next, code, message) {
    let err;
    logger.error({
      message,
      code,
    });
    if (next) {
      err = new Error(message);
      err.status = code;
      err.stack = ''; // hide stack
      return next(err);
    }

    res.writeHead(code, {
      'Content-Type': 'text/html',
    });

    return res.end(`<!doctype html>
<html>
    <head>
        <meta charset="utf-8"/>
        <title>${code} ${message}</title>
    </head>
    <body>
        <h1>${code} ${message}</h1>
    </body>
</html>`);
  }
}

// Expose to the world
/**
 * Creates a PubSubHubbub subscriber service as a HTTP server.
 * Usage:
 *     pubsub = createServer(options);
 *     pubsub.listen(1337);
 *
 * @param {Object} [options] Options object
 * @param {String} [options.callbackUrl] Callback URL for the hub
 * @param {String} [options.secret] Secret value for HMAC signatures
 * @param {Number} [options.maxContentSize] Maximum allowed size of the POST messages
 * @param {String} [headers] Custom headers to use for all HTTP requests
 * @return {Object} A PubSubHubbub server object
 */
module.exports.createServer = function createServer(options) {
  return new PubSubHubbub(options);
};
