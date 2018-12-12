const OUTPUT_JSON_STEP = "output-json";
const OUTPUT_CSV_STEP = "output-csv";

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

pg.defaults.ssl = process.env.PG_SSL !== 'false';

const dbParams = url.parse(process.env.DATABASE_URL);
const auth = dbParams.auth.split(':');

const pool = new pg.Pool({
  user: auth[0],
  password: auth[1],
  host: dbParams.hostname,
  port: dbParams.port,
  database: dbParams.pathname.split('/')[1],
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

  if (!process.env.DATABASE_URL) {
    next('Missing DATABASE_URL environment variable');
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
      const endpointMarkers = endPoints.map((endPoint, i) => '$' + (i+2)); // +2 because activity name is $1
      const markers = endpointMarkers.map(m => `(run_remote_endpoint = ${m})`).join(' or ');
      let startedResponse = false;

      columns = columns.filter((column) => exclude.indexOf(column) === -1).join(", ");

      client
        .query("SELECT " + columns + " FROM logs WHERE application = 'LARA-log-poc' AND activity = $1 AND (" + markers + ')', paramValues)
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

const getEndpoints = (req) => {
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

  let result = {};
  try {
    result = parseQuery(json);
  } catch (e) {
    return { error: e.message };
  }
  const endpointValues = result.endpointValues;
  const endpointMarkers = result.endpointMarkers;

  if (!endpointValues || endpointValues.length === 0) {
    return { error: 'Invalid query, no valid run_remote_endpoint filters found in json parameter' };
  }

  return { error: null, endpointValues, endpointMarkers };
};

const outputPortalReport = (req, res) => {
  const { error, endpointValues, endpointMarkers } = getEndpoints(req);
  if (error) {
    return res.error(error, 400);
  }

  const isCSV = req.body.format === "csv";
  const explode = req.body.explode === "yes";
  const allColumns = req.body.allColumns === "yes";

  res.type(isCSV ? 'csv' : 'json');
  res.setHeader('Content-disposition', 'attachment; filename="portal-report-' + Date.now() + (isCSV ? '.csv' : '.json"'));

  req.db(async (client, done) => {
    let startedResponse = false;
    const baseColumns = ['id', 'session', 'username', 'application', 'activity', 'event', 'time', 'parameters', 'extras', 'event_value'];
    const columns = baseColumns.slice();
    const objectColumns = ['parameters', 'extras'];
    const markers = endpointMarkers.map(m => `(run_remote_endpoint = ${m})`).join(' or ');

    let additionalColumns = [];
    if (isCSV && explode && !allColumns) {
      const query = `WITH base_ids as (SELECT id FROM logs WHERE ${markers})` +
                    `SELECT DISTINCT (each(parameters)).key FROM logs WHERE id IN (SELECT id FROM base_ids) ` +
                    `UNION ` +
                    `SELECT DISTINCT (each(extras)).key FROM logs WHERE id IN (SELECT id FROM base_ids)`;
      const result = await client.query(query, endpointValues);
      additionalColumns = additionalColumns.concat(result.rows.map(row => row.key));
    }
    if (isCSV && explode && allColumns) {
      const query = `WITH base_ids as (SELECT id FROM logs WHERE ${markers}), ` +
                    `     related_ids as (SELECT id FROM logs WHERE application IN (SELECT DISTINCT application FROM logs WHERE id in (SELECT id FROM base_ids)) AND ` +
                    `                                               activity IN (SELECT DISTINCT activity FROM logs WHERE id in (SELECT id FROM base_ids))) ` +
                    `SELECT DISTINCT (each(parameters)).key FROM logs WHERE id IN (SELECT id FROM related_ids) ` +
                    `UNION ` +
                    `SELECT DISTINCT (each(extras)).key FROM logs WHERE id IN (SELECT id FROM related_ids)`;
      const result = await client.query(query, endpointValues);
      additionalColumns = additionalColumns.concat(result.rows.map(row => row.key));
    }

    additionalColumns.sort().forEach(newCol => {
      if (columns.indexOf(newCol) === -1) {
        columns.push(newCol);
      }
    });

    const sql = `SELECT ${baseColumns.join(', ')} FROM logs WHERE ${markers}`;
    const processQuery = (step) => {
      client
      .query(sql, endpointValues)
      .on('error', (err) => {
        done();
        res.error(err.toString(), 500);
      })
      .on('row', (row) => {
        objectColumns.forEach((column) => {
          if (row.hasOwnProperty(column)) {
            hstore.parse(row[column], (result) => {
              row[column] = result;
            });
          }
        });
        if (!startedResponse) {
          if (step === OUTPUT_JSON_STEP) {
            res.write('[\n');
          }
          else if (step === OUTPUT_CSV_STEP) {
            if (explode) {
              // remove parameters and extras since they have been exploded into the columns
              columns.splice(columns.indexOf('parameters'), 1);
              columns.splice(columns.indexOf('extras'), 1);
            }
            res.write(columns.join(",") + '\n');
          }
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
        done();
        if (step === OUTPUT_JSON_STEP) {
          if (!startedResponse) {
            res.write('[\n');
          }
          res.write('\n]\n');
        }
        res.end();
      });
    };
    processQuery(isCSV ? OUTPUT_CSV_STEP : OUTPUT_JSON_STEP);
  });
};

const outputLogsCount = (req, res) => {
  const { error, endpointValues, endpointMarkers } = getEndpoints(req);
  if (error) {
    return res.error(error, 400);
  }

  res.setHeader('Content-Type', 'application/json');

  req.db(async (client, done) => {
    try {
      const markers = endpointMarkers.map(m => `(run_remote_endpoint = ${m})`).join(' or ');
      const response = await client.query(`SELECT COUNT(*) FROM logs WHERE ${markers}`, endpointValues)
      res.success(response.rows[0].count);
    } catch (e) {
      res.error(e.message, 500);
    }
    done();
  });
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
  else {
    renderPortalReportForm(req, res, req.body);
  }
});

module.exports = {app, port, mockDB};
