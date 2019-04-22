const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const pg = require('pg');
const url = require('url');
const superagent = require('superagent');
const jwt = require('jsonwebtoken');
const hstore = require('pg-hstore')();
const papaparse = require('papaparse');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const path = require('path');
const _ = require('lodash');
const parseQuery = require('./parse-query');
const translateQuery = require('./translate-query');

pg.defaults.ssl = process.env.PG_SSL !== 'false';

const OUTPUT_JSON_STEP = "output-json";
const OUTPUT_CSV_STEP = "output-csv";
const DB_BATCH_SIZE = 5000;
// Portal is passing additional data for each learner that cannot be found directly in log data.
// This list defines which properties are included.
const ADDITIONAL_LOG_COLUMNS = ["class_id"];

// use seperate RDS_DATABASE_URL because you can't override Heroku's DATABASE_URL config var
const databaseUrl = process.env.RDS_DATABASE_URL || process.env.DATABASE_URL;
if (process.env.RDS_DATABASE_URL) {
  console.log("NOTE: Using RDS_DATABASE_URL instead of DATABASE_URL");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: pg.defaults.ssl
});

let mockDBClient = null;
const mockDB = (options) => {
  mockDBClient = options ? new MockDBClient(options) : null;
};
class MockDBClient {
  constructor(options) {
    this.options = options;
    this.eventCallbacks = {};
  }
  query() {
    if (this.options.queries) {
      // Support multiple queries defined in mock config. They will be executed in the provided order.
      this.options.rows = this.options.queries.shift().rows;
    }
    const promise = new Promise(resolve => {
      this.resolvePromise = resolve;
    })
    // Bind .on method so the promise can be ignored and client code can use regular callbacks.
    promise.on = this.on.bind(this);
    setTimeout(() => this.runEvents(), 1);
    return promise;
  }
  on(event, cb) {
    this.eventCallbacks[event] = cb;
    return this;
  }
  runEvents() {
    // copy the rows so requeries use original values
    const rows = _.cloneDeep(this.options.rows || []);
    if (this.eventCallbacks.row) {
      rows.forEach((row) => {
        this.eventCallbacks.row(row);
      });
    }
    if (this.eventCallbacks.end) {
      this.eventCallbacks.end();
    }
    this.resolvePromise({ rows });
  }
}

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(bodyParser.urlencoded({extended: true, limit: "50mb", parameterLimit:50000}));
app.use(bodyParser.json({limit: "50mb"}));

app.use((req, res, next) => {

  res.type('json');

  res.error = (message, code) => {
    code = code || 500;
    res.status(code);
    res.json({success: false, error: message});
  };

  res.success = (result) => {
    res.json({success: true, result: result});
  };

  req.apiUrl = (endPoint, query) => {
    const isHeroku = process.env.HEROKU === 'true';
    const urlOptions = {
      protocol: isHeroku ? 'https' : req.protocol,
      hostname: req.hostname,
      pathname: endPoint,
      query: query
    };
    if (!isHeroku) {
      urlOptions.port = port;
    }
    return url.format(urlOptions);
  };

  req.db = (cb) => {
    if (mockDBClient) {
      cb(mockDBClient, () => {});
    }
    else {
      pool.connect((err, client, done) => {
        if (err) {
          res.error(err.toString(), 500);
        }
        else {
          cb(client, done);
        }
      });
    }
  };

  req.getOfferingInfo = (token, cb) => {

    if (!process.env.JWT_HMAC_SECRET) {
      return res.error('Missing JWT_HMAC_SECRET environment variable (needed to validate portal token)', 500);
    }

    jwt.verify(token, process.env.JWT_HMAC_SECRET, {algorithms: ['HS256']}, (err, decoded) => {
      if (err) {
        return res.error('Invalid portal token: ' + err, 401);
      }

      if (!decoded || !decoded.offering_info_url) {
        return res.error('Invalid portal token format (missing offering_info_url)', 401);
      }

      superagent
        .get(decoded.offering_info_url)
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer/JWT ' + token)
        .end((err, portalRes) => {
          if (err) {
            return res.error('Invalid portal token: portal returned "' + err + '"', 401);
          }
          cb(portalRes.body);
        });
    });
  };

  if (!databaseUrl) {
    next('Missing RDS_DATABASE_URL or DATABASE_URL environment variable');
  }
  else {
    next();
  }
});

const query = (req, res, download) => {
  const portalToken = req.query.portal_token;
  if (!portalToken) {
    return res.error('Missing portal_token query parameter', 400);
  }

  req.getOfferingInfo(portalToken, (offering) => {

    if (!offering.activity_url) {
      return res.error('The offering does not have an activity url', 500);
    }
    const matches = offering.activity_url.match(/\/activities\/(\d+)$/);
    if (!matches) {
      return res.error('The activity url of the offering is not a LARA activity: ' + offering.activity_url, 500);
    }
    const activityId = parseInt(matches[1], 10);

    if (!offering.students) {
      return res.error('The offering does not have any students', 500);
    }

    const endPoints = offering.students
      .filter((student) => (student.endpoint_url !== null) && (student.endpoint_url.length > 0))
      .map((student) => student.endpoint_url);
    if (endPoints.length === 0) {
      return res.error('No student data was found for the activity', 400);
    }

    if (download) {
      res.setHeader('Content-disposition', 'attachment; filename="activity-' + activityId + '-class-' + offering.clazz_id + '.json"');
    }

    req.db((client, done) => {
      let columns = ["id", "session", "username", "application", "activity", "event", "time", "parameters", "extras", "event_value"];
      const exclude = (req.query.exclude || "").split(",");
      const paramValues = ['activity: ' + activityId].concat(endPoints);
      const queryMarkers = endPoints.map((endPoint, i) => '$' + (i+2)); // +2 because activity name is $1
      const markers = queryMarkers.map(m => `(run_remote_endpoint = ${m})`).join(' or ');
      let startedResponse = false;

      columns = columns.filter((column) => exclude.indexOf(column) === -1).join(", ");

      const sql = "SELECT " + columns + " FROM logs WHERE application = 'LARA-log-poc' AND activity = $1 AND (" + markers + ")";
      client
        .query(sql, paramValues)
        .on('error', (err) => {
          done();
          res.error(err.toString(), 500);
        })
        .on('row', (row) => {
          ["parameters", "extras"].forEach((column) => {
            if (row.hasOwnProperty(column)) {
              hstore.parse(row[column], (result) => {
                row[column] = result;
              });
            }
          });
          if (offering.clazz_id) {
            row.class_id = offering.clazz_id;
          }
          if (!startedResponse) {
            res.write('[\n');
            startedResponse = true;
          }
          else {
            res.write(',\n');
          }
          res.write(JSON.stringify(row));
        })
        .on('end', () => {
          done();
          if (!startedResponse) {
            res.write('[\n');
          }
          res.write('\n]\n');
          res.end();
        });
    });
  });
};

const getQuery = (req) => {
  if (!process.env.JWT_HMAC_SECRET) {
    return { error: 'Missing JWT_HMAC_SECRET environment variable (needed to validate json signature)' };
  }

  let json = req.body.json;
  if (!json) {
    return { error: 'Missing json body parameter' };
  }
  const signature = req.body.signature;
  if (!signature) {
    return { error: 'Missing signature body parameter' };
  }
  const hmac = crypto.createHmac('sha256', process.env.JWT_HMAC_SECRET);
  hmac.update(json);
  const signatureBuffer = new Buffer(signature);
  const digestBuffer = new Buffer(hmac.digest('hex'));
  if ((signatureBuffer.length !== digestBuffer.length) || !crypto.timingSafeEqual(signatureBuffer, digestBuffer)) {
    return { error: 'Invalid signature for json parameter' };
  }

  try {
    json = JSON.parse(json);
  } catch (e) {
    return { error: 'Unable to parse json parameter' };
  }

  let result;
  try {
    result = parseQuery(json);
  } catch (e) {
    return { error: e.message };
  }

  let queryValues;
  let queryMarkers;
  let queryInfo = {};
  const {learners} = result;
  if (learners) {
    queryValues = learners.map(l => l.run_remote_endpoint)
    queryMarkers = learners.map((l, idx) => `(run_remote_endpoint = $${idx + 1})`).join(' or ');
    learners.forEach(l => queryInfo[l.run_remote_endpoint] = l);
  }
  else if (result.query) {
    let translated;
    try {
      translated = translateQuery(result.query);
    } catch (e) {
      return { error: e.message };
    }
    queryValues = translated.queryValues;
    queryMarkers = translated.queryMarkers;
  }
  else {
    return {error: "Missing learners or query in json"};
  }

  if (!queryValues || queryValues.length === 0) {
    return { error: 'Invalid query, no valid run_remote_endpoint filters found in json parameter' };
  }

  return { error: null, queryValues, queryMarkers, queryInfo };
};

const outputPortalReport = (req, res) => {
  const requestId = new Date().getTime();

  const { error, queryInfo, queryValues, queryMarkers } = getQuery(req);
  if (error) {
    return res.error(error, 400);
  }

  const isCSV = req.body.format === "csv";
  const explode = req.body.explode === "yes";

  res.type(isCSV ? 'csv' : 'json');
  res.setHeader('Content-disposition', 'attachment; filename="portal-report-' + Date.now() + (isCSV ? '.csv' : '.json"'));

  req.db(async (client, done) => {
    let startedResponse = false;
    const baseColumns = ['id', 'session', 'username', 'application', 'activity', 'event', 'time', 'parameters', 'extras', 'event_value', 'run_remote_endpoint'];
    let additionalColumns = ADDITIONAL_LOG_COLUMNS.slice();
    const objectColumns = ['parameters', 'extras'];

    if (isCSV && explode) {
      console.time('explode');
      const query = `WITH base_ids as (SELECT id FROM logs WHERE ${queryMarkers})` +
                    `SELECT DISTINCT (each(parameters)).key FROM logs WHERE id IN (SELECT id FROM base_ids) ` +
                    `UNION ` +
                    `SELECT DISTINCT (each(extras)).key FROM logs WHERE id IN (SELECT id FROM base_ids)`;

      try {
        const result = await client.query(query, queryValues);
        additionalColumns = additionalColumns.concat(result.rows.map(row => row.key).sort());
      } catch (error) {
        done();
        return res.error(err.message, 500);
      }
      console.timeEnd('explode');
    }

    // [ ... new Set(<some_array>) ] is a way to make sure that all the values are unique and their order is preserved.
    // .concat returns a new array, so we're not modifying baseColumns.
    const columns = [ ...new Set(baseColumns.concat(additionalColumns)) ];

    // send initial bytes so that long queries reset the inital 30 second timeout to the 55 second sliding window
    // see: https://devcenter.heroku.com/articles/request-timeout
    if (isCSV) {
      if (explode) {
        // remove parameters and extras since they have been exploded into the columns
        columns.splice(columns.indexOf('parameters'), 1);
        columns.splice(columns.indexOf('extras'), 1);
      }
      res.write(columns.join(",") + '\n');
    }
    else {
      res.write('[\n');
    }

    const processQuery = (step) => {
      const sql = `SELECT ${baseColumns.join(', ')} FROM logs WHERE ${queryMarkers}`; // NOTE: removed "ORDER BY time" to stop query from timing out
      client
        .query(sql, queryValues)
        .on('error', (err) => {
          done();
          res.error(err.toString(), 500);
        })
        .on('row', row => {
          // Parse hstore columns and extend row object.
          objectColumns.forEach(column => {
            if (row.hasOwnProperty(column)) {
              hstore.parse(row[column], (result) => {
                row[column] = result;
              });
            }
          });
          // Extend log entry with additional properties passed directly from Portal.
          ADDITIONAL_LOG_COLUMNS.forEach(column => {
            // Note that if value is not provided by Portal, it will be equal to `undefined` and JSON.stringify
            // won't serialize it.
            row[column] = queryInfo[row.run_remote_endpoint][column];
          });
          if (!startedResponse) {
            startedResponse = true;
          }
          else {
            if (step === OUTPUT_JSON_STEP) {
              res.write(',\n');
            }
          }
          if (step === OUTPUT_JSON_STEP) {
            res.write(JSON.stringify(row));
          }
          else if (step === OUTPUT_CSV_STEP) {
            const csvRow = {
              fields: columns,
              data: []
            };
            columns.forEach((column) => {
              let value = "";
              if (row.hasOwnProperty(column)) {
                const stringify = objectColumns.indexOf(column) !== -1;
                value = stringify ? JSON.stringify(row[column]) : row[column];
              }
              else if (explode) {
                objectColumns.forEach((explodedColumn) => {
                  if ((row[explodedColumn] || {}).hasOwnProperty(column)) {
                    value = row[explodedColumn][column];
                  }
                });
              }
              csvRow.data.push(value);
            });
            res.write(papaparse.unparse(csvRow, {header: false}) + '\n');
          }
        })
        .on('end', () => {
          // release the client when the stream is finished
          done();
          if (step === OUTPUT_JSON_STEP) {
            res.write('\n]\n');
          }
          res.end();
        });
    };
    processQuery(isCSV ? OUTPUT_CSV_STEP : OUTPUT_JSON_STEP);
  });
};

const outputLogsCount = (req, res) => {
  const requestId = new Date().getTime();

  const { error, queryValues, queryMarkers } = getQuery(req);
  if (error) {
    return res.error(error, 400);
  }

  res.setHeader('Content-Type', 'application/json');

  req.db(async (client, done) => {
    try {
      const response = await client.query(`SELECT COUNT(*) FROM logs WHERE ${queryMarkers}`, queryValues)
      res.success(response.rows[0].count);
    } catch (e) {
      res.error(e.message, 500);
    }
    done();
  });
};

const outputLogsDebug = (req, res) => {
  const result = getQuery(req);
  if (result.error) {
    return res.error(result.error, 400);
  }
  else {
    return res.success(result);
  }
};

app.get('/', (req, res) => {
  const params = {
    portal_token: 'PORTAL-GENERATED-TOKEN'
  };
  res.success({
    links: {
      self: {
        desc: 'link to self',
        url: req.apiUrl('/')
      },
      download: {
        desc: 'link to download query results (note need for portal generated token)',
        url: req.apiUrl('/download', params)
      },
      view: {
        desc: 'link to view query results (note need for portal generated token)',
        url: req.apiUrl('/view', params)
      },
      "portal-report": {
        desc: 'link to download report results (note need for json query and signature)',
        url: req.apiUrl('/portal-report', {
          json: 'PORTAL-REPORT-JSON',
          signature: 'HEX-HMAC-OF-PORTAL-REPORT-JSON',
        })
      }
    }
  });
});

const renderPortalReportForm = (req, res, params) => {
  // check if warning is needed about counting logs
  if (params.json) {
    try {
      json = JSON.parse(params.json);
      if (json && json.learners && json.learners.length) {
        params.count_logs_warning = `NOTE: There are ${json.learners.length} learners in the query.  Using "Count Logs" when there are many learners may result in a query timeout.`;
      }
    } catch (e) {}
  }
  res.type('html');
  res.render('portal-report', params);
};

app.get('/view', (req, res) => {
  query(req, res, false);
});

app.get('/download', (req, res) => {
  query(req, res, true);
});

app.get('/portal-report', (req, res) => {
  renderPortalReportForm(req, res, req.query);
});

app.post('/logs-count', (req, res) => {
  renderPortalReportForm(req, res, req.query);
});

app.get('/portal-report-tester', (req, res) => {
  res.type('html');
  res.render('portal-report-tester', req.query);
});

app.post('/portal-report', (req, res) => {
  if (req.body.count) {
    outputLogsCount(req, res);
  }
  else if (req.body.download) {
    outputPortalReport(req, res);
  }
  else if (req.body.debug) {
    outputLogsDebug(req, res);
  }
  else {
    renderPortalReportForm(req, res, req.body);
  }
});

module.exports = {app, port, mockDB};
