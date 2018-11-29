var OUTPUT_JSON_STEP = "output-json";
var OUTPUT_CSV_STEP = "output-csv";
var GET_EXPLODED_COLUMNS_STEP = "get-exploded-columns";

var express = require('express');
var app = express();
var port = process.env.PORT || 3000;
var pg = require('pg');
var url = require('url');
var URLSafeBase64 = require('urlsafe-base64');
var superagent = require('superagent');
var jwt = require('jsonwebtoken');
var hstore = require('pg-hstore')();
var papaparse = require('papaparse');
var crypto = require('crypto');
var bodyParser = require('body-parser');
var path = require('path');

pg.defaults.ssl = process.env.PG_SSL !== 'false';

var dbParams = url.parse(process.env.DATABASE_URL);
var auth = dbParams.auth.split(':');

var pool = new pg.Pool({
  user: auth[0],
  password: auth[1],
  host: dbParams.hostname,
  port: dbParams.port,
  database: dbParams.pathname.split('/')[1],
  ssl: pg.defaults.ssl
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(bodyParser.urlencoded({extended: true, limit: "50mb", parameterLimit:50000}));
app.use(bodyParser.json({limit: "50mb"}));

app.use(function (req, res, next) {

  res.type('json');

  res.error = function (message, code) {
    code = code || 500;
    res.code = code;
    res.json({success: false, error: message});
  };

  res.success = function (result) {
    res.json({success: true, result: result});
  };

  req.apiUrl = function(endPoint, query) {
    var isHeroku = process.env.HEROKU === 'true';
    var urlOptions = {
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

  req.db = function (cb) {
    pool.connect(function (err, client, done) {
      if (err) {
        res.error(err.toString());
      }
      else {
        cb(client, done);
      }
    });
  };

  req.getOfferingInfo = function (token, cb) {

    if (!process.env.JWT_HMAC_SECRET) {
      return res.error('Missing JWT_HMAC_SECRET environment variable (needed to validate portal token');
    }

    jwt.verify(token, process.env.JWT_HMAC_SECRET, function (err, decoded) {
      if (err) {
        return res.error('Invalid portal token: ' + err);
      }

      if (!decoded || !decoded.offering_info_url) {
        return res.error('Invalid portal token format (missing offering_info_url).  Decoded token is ' + JSON.stringify(decoded));
      }

      superagent
        .get(decoded.offering_info_url)
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer/JWT ' + token)
        .end(function (err, portalRes) {
          if (err) {
            return res.error('Invalid portal token: portal returned "' + err + '"');
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

var query = function (req, res, download) {
  var portalToken = req.query.portal_token;
  if (!portalToken) {
    return res.error('Missing portal_token query parameter');
  }

  req.getOfferingInfo(portalToken, function (offering) {

    if (!offering.activity_url) {
      return res.error('The offering does not have an activity url', 500);
    }
    var matches = offering.activity_url.match(/\/activities\/(\d+)$/);
    if (!matches) {
      return res.error('The activity url of the offering is not a LARA activity: ' + offering.activity_url, 500);
    }
    var activityId = parseInt(matches[1], 10);

    if (!offering.students) {
      return res.error('The offering does not have any students', 500);
    }

    var endPoints = offering.students
      .filter(function (student) { return (student.endpoint_url !== null) && (student.endpoint_url.length > 0); })
      .map(function (student) { return student.endpoint_url; });
    if (endPoints.length === 0) {
      return res.error('No student data was found for the activity');
    }

    if (download) {
      res.setHeader('Content-disposition', 'attachment; filename="activity-' + activityId + '-class-' + offering.clazz_id + '.json"');
    }

    req.db(function (client, done) {
      var rows = [];
      var columns = ["id", "session", "username", "application", "activity", "event", "time", "parameters", "extras", "event_value"];
      var exclude = (req.query.exclude || "").split(",");
      var paramValues = ['activity: ' + activityId].concat(endPoints);
      var endpointMarkers = endPoints.map(function (endPoint, i) { return '$' + (i+2); }); // +2 because activity name is $1
      var startedResponse = false;

      columns = columns.filter(function (column) {
        return exclude.indexOf(column) === -1;
      }).join(", ");

      client
        .query("SELECT " + columns + " FROM logs WHERE application = 'LARA-log-poc' AND activity = $1 AND run_remote_endpoint in (" + endpointMarkers + ')', paramValues)
        .on('error', function (err) {
          done();
          res.error(err.toString());
        })
        .on('row', function (row) {
          ["parameters", "extras"].forEach(function (column) {
            if (row.hasOwnProperty(column)) {
              hstore.parse(row[column], function (result) {
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
        .on('end', function () {
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

var outputPortalReport = function (req, res) {
  var isCSV = req.body.format === "csv";
  var explode = req.body.explode === "yes";

  if (!process.env.JWT_HMAC_SECRET) {
    return res.error('Missing JWT_HMAC_SECRET environment variable (needed to validate json signature');
  }

  var json = req.body.json;
  if (!json) {
    return res.error('Missing json query parameter');
  }
  var signature = req.body.signature;
  if (!signature) {
    return res.error('Missing signature query parameter');
  }
  var hmac = crypto.createHmac('sha256', process.env.JWT_HMAC_SECRET);
  hmac.update(json);
  var signatureBuffer = new Buffer(signature);
  var digestBuffer = new Buffer(hmac.digest('hex'));
  if ((signatureBuffer.length !== digestBuffer.length) || !crypto.timingSafeEqual(signatureBuffer, digestBuffer)) {
    return res.error('Invalid signature for json parameter');
  }

  try {
    json = JSON.parse(json);
  }
  catch (e) {
    return res.error('Unable to parse json parameter');
  }
  if (!json || !json.filter) {
    return res.error('Missing query filter section in json parameter');
  }

  var endpointValues = [];
  var endpointMarkers = [];
  var endpointMarkerIndex = 1;
  json.filter.forEach((filter) => {
    if (filter.key === 'run_remote_endpoint') {
      (filter.list || []).forEach(function (endpoint) {
        endpointValues.push(endpoint);
        endpointMarkers.push('$' + endpointMarkerIndex++);
      });
    }
  });
  if (endpointValues.length === 0) {
    return res.error('Invalid query, no valid run_remote_endpoint filters found in json parameter');
  }

  res.type(isCSV ? 'csv' : 'json');
  res.setHeader('Content-disposition', 'attachment; filename="portal-report-' + Date.now() + (isCSV ? '.csv' : '.json"'));

  req.db(function (client, done) {
    var rows = [];
    var startedResponse = false;
    var columns = ['id', 'session', 'username', 'application', 'activity', 'event', 'time', 'parameters', 'extras', 'event_value'];
    var objectColumns = ['parameters', 'extras'];
    var sql = `SELECT ${columns.join(', ')} FROM logs WHERE run_remote_endpoint IN (${endpointMarkers.join(', ')})`;

    var processQuery = function (step) {
      client
      .query(sql, endpointValues)
      .on('error', function (err) {
        done();
        res.error(err.toString());
      })
      .on('row', function (row) {
        objectColumns.forEach(function (column) {
          if (row.hasOwnProperty(column)) {
            hstore.parse(row[column], function (result) {
              row[column] = result;
            });
            if (step == GET_EXPLODED_COLUMNS_STEP) {
              Object.keys(row[column] || {}).forEach(function (explodedColumn) {
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
            var csvRow = {
              fields: columns,
              data: []
            };
            columns.forEach(function (column) {
              var value = "";
              if (row.hasOwnProperty(column)) {
                var stringify = objectColumns.indexOf(column) !== -1;
                value = stringify ? JSON.stringify(row[column]) : row[column];
              }
              else if (explode) {
                objectColumns.forEach(function (explodedColumn) {
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
      .on('end', function () {
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

app.get('/', function (req, res) {
  var params = {
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

var renderPortalReportForm = function (req, res, params) {
  res.type('html');
  res.render('portal-report', params);
};

app.get('/view', function (req, res) {
  query(req, res, false);
});

app.get('/download', function (req, res) {
  query(req, res, true);
});

app.get('/portal-report', function (req, res) {
  renderPortalReportForm(req, res, req.query);
});

app.get('/portal-report-tester', function (req, res) {
  res.type('html');
  res.render('portal-report-tester', req.query);
});

app.post('/portal-report', function (req, res) {
  if (req.body.download) {
    outputPortalReport(req, res);
  }
  else {
    renderPortalReportForm(req, res, req.body);
  }
});

app.listen(port, function () {
  console.log('Listening on port ' + port);
});

