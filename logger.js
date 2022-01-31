const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  // format: format.json(),
  format: format.combine(format.timestamp(), format.splat(), format.json()),
  defaultMeta: { service: 'ytpubsub' },
  transports: [
    //
    // - Write to all logs with level `info` and below to `combined.log`
    // - Write all logs error (and below) to `error.log`.
    //
    new transports.File({
      filename: 'error.log',
      level: 'error',
    }),
    new transports.File({ filename: 'combined.log' }),
  ],
});

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
const consoleTransport = new transports.Console({
  format: format.combine(
    format.colorize(),
    format.simple(),
    format.timestamp(),
    format.splat(),
    format.printf(
      (info) => `${new Date(info.timestamp).toLocaleString()} [${
        info.level
      }]: ${JSON.stringify(info.message)}`,
    ),
    // format.json(),
  ),
});

if (process.env.NODE_ENV === 'development') {
  consoleTransport.level = 'silly';
}

if (process.env.NODE_ENV !== 'production') {
  logger.add(consoleTransport);
}

module.exports = logger;
