const OUTPUT_JSON_STEP = "output-json";
const OUTPUT_CSV_STEP = "output-csv";
const GET_EXPLODED_COLUMNS_STEP = "get-exploded-columns";

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
const pg = require('pg');
const url = require('url');
const URLSafeBase64 = require('urlsafe-base64');
const superagent = require('superagent');
const jwt = require('jsonwebtoken');
const hstore = require('pg-hstore')();
const papaparse = require('papaparse');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const path = require('path');
const _ = require('lodash');

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
    return this;
  }
  on(event, cb) {
    this.eventCallbacks[event] = cb;
    if (event === 'end') {
      setTimeout(() => this.runEvents(), 1);
    }
    return this;
  }
  runEvents() {
    // copy the rows so requeries use original values
    const rows = _.cloneDeep(this.options.rows || []);
    rows.forEach((row) => {
      this.eventCallbacks.row(row);
    });
    this.eventCallbacks.end();
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
      const rows = [];
      let columns = ["id", "session", "username", "application", "activity", "event", "time", "parameters", "extras", "event_value"];
      const exclude = (req.query.exclude || "").split(",");
      const paramValues = ['activity: ' + activityId].concat(endPoints);
      const endpointMarkers = endPoints.map((endPoint, i) => '$' + (i+2)); // +2 because activity name is $1
      let startedResponse = false;

      columns = columns.filter((column) => exclude.indexOf(column) === -1).join(", ");

      client
        .query("SELECT " + columns + " FROM logs WHERE application = 'LARA-log-poc' AND activity = $1 AND run_remote_endpoint in (" + endpointMarkers + ')', paramValues)
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

const outputPortalReport = (req, res) => {
  const isCSV = req.body.format === "csv";
  const explode = req.body.explode === "yes";

  if (!process.env.JWT_HMAC_SECRET) {
    return res.error('Missing JWT_HMAC_SECRET environment variable (needed to validate json signature', 500);
  }

  let json = req.body.json;
  if (!json) {
    return res.error('Missing json body parameter', 400);
  }
  const signature = req.body.signature;
  if (!signature) {
    return res.error('Missing signature body parameter', 400);
  }
  const hmac = crypto.createHmac('sha256', process.env.JWT_HMAC_SECRET);
  hmac.update(json);
  const signatureBuffer = new Buffer(signature);
  const digestBuffer = new Buffer(hmac.digest('hex'));
  if ((signatureBuffer.length !== digestBuffer.length) || !crypto.timingSafeEqual(signatureBuffer, digestBuffer)) {
    return res.error('Invalid signature for json parameter', 400);
  }

  try {
    json = JSON.parse(json);
  }
  catch (e) {
    return res.error('Unable to parse json parameter', 500);
  }
  if (!json || !json.filter) {
    return res.error('Missing query filter section in json parameter', 400);
  }

  const endpointValues = [];
  const endpointMarkers = [];
  let endpointMarkerIndex = 1;
  json.filter.forEach((filter) => {
    if (filter.key === 'run_remote_endpoint') {
      (filter.list || []).forEach((endpoint) => {
        endpointValues.push(endpoint);
        endpointMarkers.push('$' + endpointMarkerIndex++);
      });
    }
  });
  if (endpointValues.length === 0) {
    return res.error('Invalid query, no valid run_remote_endpoint filters found in json parameter', 400);
  }

  res.type(isCSV ? 'csv' : 'json');
  res.setHeader('Content-disposition', 'attachment; filename="portal-report-' + Date.now() + (isCSV ? '.csv' : '.json"'));

  req.db((client, done) => {
    const rows = [];
    let startedResponse = false;
    const columns = ['id', 'session', 'username', 'application', 'activity', 'event', 'time', 'parameters', 'extras', 'event_value'];
    const objectColumns = ['parameters', 'extras'];
    const sql = `SELECT ${columns.join(', ')} FROM logs WHERE run_remote_endpoint IN (${endpointMarkers.join(', ')})`;

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
            if (step == GET_EXPLODED_COLUMNS_STEP) {
              Object.keys(row[column] || {}).forEach((explodedColumn) => {
                if (columns.indexOf(explodedColumn) === -1) {
                  columns.push(explodedColumn);
                }
              });
            }
          }
        });
        if (step != GET_EXPLODED_COLUMNS_STEP) {
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
        }
      })
      .on('end', () => {
        if (step === GET_EXPLODED_COLUMNS_STEP) {
          processQuery(OUTPUT_CSV_STEP);
        }
        else {
          done();
          if (step === OUTPUT_JSON_STEP) {
            if (!startedResponse) {
              res.write('[\n');
            }
            res.write('\n]\n');
          }
          res.end();
        }
      });
    };
    processQuery(isCSV ? (explode ? GET_EXPLODED_COLUMNS_STEP : OUTPUT_CSV_STEP) : OUTPUT_JSON_STEP);
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

app.get('/portal-report-tester', (req, res) => {
  res.type('html');
  res.render('portal-report-tester', req.query);
});

app.post('/portal-report', (req, res) => {
  if (req.body.download) {
    outputPortalReport(req, res);
  }
  else {
    renderPortalReportForm(req, res, req.body);
  }
});

module.exports = {app, port, mockDB};
