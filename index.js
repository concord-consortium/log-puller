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
    return url.format({
      protocol: req.protocol,
      hostname: req.hostname,
      port: port,
      pathname: endPoint,
      query: query
    });
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

  req.getClassInfo = function (token, cb) {
    var decoded = jwt.decode(token);
    if (!decoded || !decoded.claims || !decoded.claims.class_info_url) {
      return res.error('Invalid portal token.  Decoded token is ' + JSON.stringify(decoded));
    }

    superagent
      .get(decoded.claims.class_info_url)
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Bearer ' + token)
      .end(function (err, portalRes) {
        if (err) {
          return res.error('Invalid portal token: portal returned "' + err + '"');
        }
        cb(portalRes.body);
      });
  };

  if (!process.env.DATABASE_URL) {
    next('Missing DATABASE_URL in environment variables');
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
  var laraId = parseInt(req.query.lara_id, 10);
  if (!laraId) {
    return res.error('Missing lara_id query parameter');
  }
  var portalToken = req.query.portal_token;
  if (!portalToken) {
    return res.error('Missing portal_token query parameter');
  }
  var classId = parseInt(req.query.class_id || "0", 10); // not required

  req.getClassInfo(portalToken, function (classInfo) {

    var activity = ((classInfo && classInfo.lara_activities) || []).find(function (activity) {
      return activity.lara_id == laraId;
    });
    if (!activity) {
      return res.error('Unknown lara activity: ' + laraId);
    }
    if (activity.remote_endpoint_urls.length === 0) {
      return res.error('No student data was found for the activity');
    }

    res.contentType('application/json');
    if (download) {
      res.setHeader('Content-disposition', 'attachment; filename="activity-' + laraId + (classId ? '-class-' + classId : '') + '.json"');
    }

    req.db(function (client, done) {
      var rows = [];
      var columns = ["id", "session", "username", "application", "activity", "event", "time", "parameters", "extras", "event_value"];
      var exclude = (req.query.exclude || "").split(",");
      var paramValues = ['activity: ' + activity.lara_id].concat(activity.remote_endpoint_urls);
      var endpointMarkers = activity.remote_endpoint_urls.map(function (endPoint, i) { return '$' + (i+2); }); // +2 because activity name is $1
      var startedResponse = false;

      // for DEMO replace local generated links with production - REMOVE THIS AFTER DEMO!
      paramValues = paramValues.map(function (paramValue) { return paramValue.replace('http://railsdev:9000', 'https://learn.concord.org'); });

      columns = columns.filter(function (column) {
        return exclude.indexOf(column) === -1;
      }).join(", ");

      client
        .query("SELECT " + columns + " FROM logs WHERE application = 'LARA-log-poc' AND activity = $1 AND extras->'run_remote_endpoint' in (" + endpointMarkers + ')', paramValues)
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
          if (classId) {
            row.class_id = classId;
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

app.get('/', function (req, res) {
  var params = {
    lara_id: 'LARA-ACTIVITY-ID',
    portal_token: 'PORTAL-TOKEN',
    class_id: 'OPTIONAL-CLASS-ID'
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

app.listen(port, function () {
  console.log('Listening on port ' + port);
});

