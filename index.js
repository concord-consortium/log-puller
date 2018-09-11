var express = require('express');
var app = express();
var port = process.env.PORT || 3000;
var pg = require('pg');
var url = require('url');
var URLSafeBase64 = require('urlsafe-base64');
var superagent = require('superagent');
var jwt = require('jsonwebtoken');

pg.defaults.ssl = process.env.PG_SSL !== 'false';

var dbParams = url.parse(process.env.DATABASE_URL);
var auth = dbParams.auth.split(':');

var pool = new pg.Pool({
  user: auth[0],
  password: auth[1],
  host: dbParams.hostname,
  port: dbParams.port,
  database: dbParams.pathname.split('/')[1],
  ssl: true
});

app.use(function (req, res, next) {

  res.contentType('application/json');

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

var parseRubyHash = function (rubyHashString) {
  var result = {};
  var chars = rubyHashString.split("");
  var index = 0;
  var ch = chars[index];

  var readString = function () {
    if (ch !== '"') {
      return null;
    }
    var string = [];
    var prevCh = chars[index - 1];
    match('"');
    while ((index < chars.length) && (ch !== '"') && (prevCh !== '\\')) {
      string.push(ch);
      prevCh = ch;
      advance(1);
    }
    match('"');
    return string.join("");
  };
  var advance = function (n) {
    index += n;
    ch = chars[index];
  };
  var match = function (lexeme) {
    advance(lexeme.length);
  };

  while (index < chars.length) {
    var key = readString();
    match("=>");
    result[key] = readString();
    while ((index < chars.length) && (ch !== '"')) {
      advance(1);
    }
  }

  return result;
};

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

    res.contentType('application/json');
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

      // for DEMO replace local generated links with downloaded production links - REMOVE THIS AFTER DEMO!
      paramValues = paramValues.map(function (paramValue) { return paramValue.replace('http://railsdev:9000', 'https://learn.concord.org'); });

      columns = columns.filter(function (column) {
        return exclude.indexOf(column) === -1;
      }).join(", ");

      var sql = "SELECT " + columns + " FROM logs WHERE application = 'LARA-log-poc' AND activity = $1 AND extras->'run_remote_endpoint' in (" + endpointMarkers + ')';
      console.log("QUERY:", sql);
      client
        .query(sql, paramValues)
        .on('error', function (err) {
          done();
          res.error(err.toString());
        })
        .on('row', function (row) {
          ["parameters", "extras"].forEach(function (column) {
            if (row.hasOwnProperty(column)) {
              row[column] = parseRubyHash(row[column]);
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

var getDumpName = function (startRow) {
  return 'log-manager-dump-' + startRow + '.json';
};

var dump = function (req, res) {
  var dumpKey = req.query.dump_key;
  if (!dumpKey) {
    return res.error('Missing dump_key query parameter');
  }
  if (dumpKey !== process.env.DUMP_KEY) {
    return res.error('Incorrect dump_key');
  }

  var startRow = parseInt(req.query.start_row) || 1;
  var numRows = parseInt(req.query.num_rows) || 1000;
  var sql = "SELECT id, session, username, application, activity, event, time, parameters, extras, event_value, run_remote_endpoint FROM logs where id >= " + startRow + " and id < " + (startRow + numRows) + " order by id";

  res.contentType('application/json');
  res.setHeader('Content-disposition', 'attachment; filename="' + getDumpName(startRow) + '"');

  req.db(function (client, done) {
    client
      .query(sql)
      .on('error', function (err) {
        done();
        res.error(err.toString());
      })
      .on('row', function (row) {
        ["parameters", "extras"].forEach(function (column) {
          if (row.hasOwnProperty(column)) {
            row[column] = parseRubyHash(row[column]);
          }
        });
        delete row.parameters;
        delete row.extras;
        res.write(JSON.stringify(row));
        res.write('\n');
      })
      .on('end', function () {
        done();
        res.end();
      });
  });
};

var wgetList = function (req, res) {
  var dumpKey = req.query.dump_key;
  if (!dumpKey) {
    return res.error('Missing dump_key query parameter');
  }
  if (dumpKey !== process.env.DUMP_KEY) {
    return res.error('Incorrect dump_key');
  }

  res.contentType('text/plain');

  req.db(function (client, done) {
    client
      .query("SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM logs")
      .on('error', function (err) {
        done();
        res.error(err.toString());
      })
      .on('row', function (row) {
        var minId = parseInt(row.min_id);
        var maxId = parseInt(row.max_id);
        var numRows = parseInt(req.query.num_rows) || 1000;

        res.write('# min_id = ' + row.min_id + ' max_id = ' + row.max_id + '\n');

        for (var i = minId; i < maxId; i += numRows) {
          res.write('wget -O ' + getDumpName(i) + " 'https://log-puller.herokuapp.com/dump?dump_key=" + dumpKey + '&start_row=' + i + '&num_rows=' + numRows + "'\n");
        }
      })
      .on('end', function () {
        done();
        res.end();
      });
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
      }
    }
  });
});

app.get('/view', function (req, res) {
  query(req, res, false);
});

app.get('/download', function (req, res) {
  query(req, res, true);
});

app.get('/dump', function (req, res) {
  dump(req, res);
});

app.get('/wget-list', function (req, res) {
  wgetList(req, res);
});

app.listen(port, function () {
  console.log('Listening on port ' + port);
});

