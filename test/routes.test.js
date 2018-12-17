require('./test-env');

const request = require('supertest');
const {app, mockDB} = require('../app');
const jwt = require('jsonwebtoken');
const nock = require('nock');
const crypto = require('crypto');

const NOCK = 'http://example.com';
const OFFERING = '/offering';
const TEST_OFFERING_INFO_URL = `${NOCK}${OFFERING}`;

const createJWT = (options) => {
  options = options || {};
  const algorithm = options.alg || 'HS256';
  const payload = {
    alg: algorithm,
    uid: options.uid || 1
  };
  if (!options.skipOfferingInfoUrl) {
    payload.offering_info_url = options.offeringInfoUrl || TEST_OFFERING_INFO_URL;
  }
  return jwt.sign(payload, options.secret || process.env.JWT_HMAC_SECRET, {expiresIn: 3600, algorithm});
};

const sign = (s) => {
  const hmac = crypto.createHmac('sha256', process.env.JWT_HMAC_SECRET);
  hmac.update(s);
  return hmac.digest('hex');
};

describe('/', () => {
  test('should respond to GET', () => {
    return request(app)
      .get('/')
      .expect(200);
  });
});

describe('/view', () => {
  test('should fail without portal_token', () => {
    return request(app)
      .get('/view')
      .expect(400)
      .expect({success: false, error: 'Missing portal_token query parameter'});
  });

  test('should fail with malformed portal_token', () => {
    return request(app)
      .get('/view?portal_token=invalid')
      .expect(401)
      .expect({success: false, error: 'Invalid portal token: JsonWebTokenError: jwt malformed'});
  });

  test('should fail with invalid portal_token algorithm', () => {
    const portalToken = createJWT({alg: 'HS384'});
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(401)
      .expect({success: false, error: 'Invalid portal token: JsonWebTokenError: invalid algorithm'});
  });

  test('should fail with portal_token without offering_info_url', () => {
    const portalToken = createJWT({skipOfferingInfoUrl: true});
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(401)
      .expect({success: false, error: 'Invalid portal token format (missing offering_info_url)'});
  });

  test('should fail with an offering without an activity_url', () => {
    const portalToken = createJWT();
    nock(NOCK)
      .get(OFFERING)
      .reply(200, {});
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(500)
      .expect({success: false, error: 'The offering does not have an activity url'});
  });

  test('should fail with an offering with a non-LARA activity_url', () => {
    const portalToken = createJWT();
    nock(NOCK)
      .get(OFFERING)
      .reply(200, {activity_url: 'invalid'});
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(500)
      .expect({success: false, error: 'The activity url of the offering is not a LARA activity: invalid'});
  });

  test('should fail with an offering with a LARA activity without students', () => {
    const portalToken = createJWT();
    nock(NOCK)
      .get(OFFERING)
      .reply(200, {activity_url: 'valid/activities/1'});
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(500)
      .expect({success: false, error: 'The offering does not have any students'});
  });

  test('should fail with an offering with a LARA activity with 0 students', () => {
    const portalToken = createJWT();
    nock(NOCK)
      .get(OFFERING)
      .reply(200, {activity_url: 'valid/activities/1', students: []});
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(400)
      .expect({success: false, error: 'No student data was found for the activity'});
  });

  test('should succeed with a valid offering', () => {
    const portalToken = createJWT();
    nock(NOCK)
      .get(OFFERING)
      .reply(200, {activity_url: 'valid/activities/1', clazz_id: 1, students: [{endpoint_url: "1"}, {endpoint_url: "2"}]});
    mockDB({
      rows: [
        {id: 1, event: 'test 1'},
        {id: 2, event: 'test 2'},
      ]
    });
    return request(app)
      .get(`/view?portal_token=${portalToken}`)
      .expect(200)
      .expect([
        {id: 1, event: 'test 1', class_id: 1},
        {id: 2, event: 'test 2', class_id: 1},
      ]);
  });
});

// NOTE: the view and download paths exercise the same code, they just set the return header differently
describe('/download', () => {
  test('should succeed with a valid offering', () => {
    const portalToken = createJWT();
    nock(NOCK)
      .get(OFFERING)
      .reply(200, {activity_url: 'valid/activities/1', clazz_id: 2, students: [{endpoint_url: "1"}, {endpoint_url: "2"}]});
    mockDB({
      rows: [
        {id: 1, event: 'test 1'},
        {id: 2, event: 'test 2'},
      ]
    });
    return request(app)
      .get(`/download?portal_token=${portalToken}`)
      .expect(200)
      .expect('Content-disposition', /attachment; filename="activity-1-class-2\.json/)
      .expect([
        {id: 1, event: 'test 1', class_id: 2},
        {id: 2, event: 'test 2', class_id: 2},
      ]);
  });
});

describe('/portal-report', () => {
  test('GET should return form', () => {
    return request(app)
      .get('/portal-report')
      .expect(200, /<form method="post">/);
  });

  test('empty POST should return form', () => {
    return request(app)
      .post('/portal-report')
      .expect(200);
  });

  test('form POST without json body parameter should fail', () => {
    return request(app)
      .post('/portal-report')
      .send({download: true})
      .expect(400)
      .expect({success: false, error: 'Missing json body parameter'});
  });

  test('form POST with an invalid json signature parameter should fail', () => {
    return request(app)
      .post('/portal-report')
      .send({download: true, json: "{}", signature: "invalid"})
      .expect(400)
      .expect({success: false, error: 'Invalid signature for json parameter'});
  });

  test('form POST with an invalid json parameter should fail', () => {
    return request(app)
      .post('/portal-report')
      .send({download: true, json: "invalid", signature: sign("invalid")})
      .expect(400)
      .expect({success: false, error: 'Unable to parse json parameter'});
  });

  test('form POST with an json parameter without a filter or run_remote_endpoints should fail', () => {
    return request(app)
      .post('/portal-report')
      .send({download: true, json: "{}", signature: sign("{}")})
      .expect(400)
      .expect({success: false, error: 'Unsupported query format - missing filter/learners section in json parameter'});
  });

  test('form POST with an json parameter without run_remote_endpoints should fail', () => {
    return request(app)
      .post('/portal-report')
      .send({download: true, json: '{"filter": []}', signature: sign('{"filter": []}')})
      .expect(400)
      .expect({success: false, error: 'Invalid query, no valid run_remote_endpoint filters found in json parameter'});
  });

  test('Log Manager query json form POST should succeed', () => {
    const json = `
    {
      "filter": [
          {
              "key": "run_remote_endpoint",
              "list": [
                  "https://example.com/1"
              ],
              "remove": false,
              "filter_type": "string"
          }
      ],
      "filter_having_keys": {
          "keys_list": []
      },
      "measures": [],
      "child_query": {
          "filter": [],
          "add_child_data": true
      }
    }
    `;
    mockDB({
      rows: [
        {id: 1, event: 'test 1', parameters: '"foo"=>"bar","baz"=>"bam"', extras: '"biff"=>"true"', run_remote_endpoint: "https://example.com/1"},
        {id: 2, event: 'test 2', run_remote_endpoint: "https://example.com/1"},
      ]
    });
    return request(app)
      .post('/portal-report')
      .send({download: true, json: json, signature: sign(json)})
      .expect('Content-disposition', /attachment; filename="portal-report-(\d+)\.json/)
      .expect([
        {id: 1, event: 'test 1', parameters: {foo: 'bar', baz: 'bam'}, extras: {biff: 'true'}, run_remote_endpoint: "https://example.com/1"},
        {id: 2, event: 'test 2', run_remote_endpoint: "https://example.com/1"},
      ]);
  });

  test('simple query json form POST should succeed', () => {
    const json = `
    {
      "learners": [
        {"run_remote_endpoint": "https://example.com/1", "class_id": 123}
      ]
    }
    `;
    mockDB({
      rows: [
        {id: 1, event: 'test 1', parameters: '"foo"=>"bar","baz"=>"bam"', extras: '"biff"=>"true"', run_remote_endpoint: "https://example.com/1"},
        {id: 2, event: 'test 2', run_remote_endpoint: "https://example.com/1"},
      ]
    });
    return request(app)
      .post('/portal-report')
      .send({download: true, json: json, signature: sign(json)})
      .expect('Content-disposition', /attachment; filename="portal-report-(\d+)\.json/)
      .expect([
        {id: 1, event: 'test 1', parameters: {foo: 'bar', baz: 'bam'}, extras: {biff: 'true'}, run_remote_endpoint: "https://example.com/1", class_id: 123},
        {id: 2, event: 'test 2', run_remote_endpoint: "https://example.com/1", class_id: 123},
      ]);
  });

  test('csv form without explode POST should succeed', () => {
    const json = `
     {
      "learners": [
        {"run_remote_endpoint": "https://example.com/1", "class_id": 123}
      ]
    }
    `;
    mockDB({
      rows: [
        {id: 1, event: 'test 1', parameters: '"foo"=>"bar","baz"=>"bam"', extras: '"biff"=>"true"', run_remote_endpoint: "https://example.com/1"},
        {id: 2, event: 'test 2', run_remote_endpoint: "https://example.com/1"},
      ]
    });
    return request(app)
      .post('/portal-report')
      .send({download: true, json: json, signature: sign(json), format: 'csv'})
      .expect('Content-disposition', /attachment; filename="portal-report-(\d+)\.csv/)
      .expect(200, 'id,session,username,application,activity,event,time,parameters,extras,event_value,run_remote_endpoint,class_id\n1,,,,,test 1,,"{""foo"":""bar"",""baz"":""bam""}","{""biff"":""true""}",,https://example.com/1,123\n2,,,,,test 2,,,,,https://example.com/1,123\n');
  });

  test('csv form with explode POST should succeed', () => {
    const json = `
    {
      "learners": [
        {"run_remote_endpoint": "https://example.com/1", "class_id": 123}
      ]
    }
    `;
    mockDB({
      queries: [
        {
          rows: [
            {key: "foo"},
            {key: "baz"},
            {key: "biff"}
          ]
        },
        {
          rows: [
            {id: 1, event: 'test 1', parameters: '"foo"=>"bar","baz"=>"bam"', extras: '"biff"=>"true"', run_remote_endpoint: "https://example.com/1"},
            {id: 2, event: 'test 2', run_remote_endpoint: "https://example.com/1"},
          ]
        }
      ]
    });
    return request(app)
      .post('/portal-report')
      .send({download: true, json: json, signature: sign(json), format: 'csv', explode: 'yes'})
      .expect('Content-disposition', /attachment; filename="portal-report-(\d+)\.csv/)
      .expect(200, 'id,session,username,application,activity,event,time,event_value,run_remote_endpoint,class_id,baz,biff,foo\n1,,,,,test 1,,,https://example.com/1,123,bam,true,bar\n2,,,,,test 2,,,https://example.com/1,123,,,\n');
  });

  test('count request should succeed', () => {
    const json = `
    {
      "learners": [
        {"run_remote_endpoint": "https://example.com/1"}
      ]
    }
    `;
    mockDB({
      rows: [
        {count: 123},
      ]
    });
    return request(app)
      .post('/portal-report')
      .send({count: true, json: json, signature: sign(json)})
      .expect('Content-type', /application\/json/)
      .expect(200, {success: true, result: 123});
  });

});

describe('/portal-report-tester', () => {
  test('GET should return form', () => {
    return request(app)
      .get('/portal-report-tester')
      .expect(200, /<form method="post" action="\/portal-report">/);
  });
});
