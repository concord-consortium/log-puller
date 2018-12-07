# log-puller

This app runs on Heroku and points to the cc-log-manager app's database.  Its original purpose
was to allow for filtered log data queries based on the user's portal credentials passed as a json web token.  It has since been extended to handle log manager JSON queryies from the report portal.

Originally the app exposed two GET endpoints: `/download` and `/view`.  They both ran the same
query but `/download` set the Content-Disposition header so the result of the query
is downloaded in the browser whereas `/view` just streamed the result to the browser.

A new `/portal-report` GET and POST endpoint was added that accepts two parameters: `json` which is the report
JSON generated by the report portal and `signature` which is an HMAC signature of the `json`
parameter using the shared `JWT_HMAC_SECRET`.  The endpoint also accepts a `format` parameter that
can be set to `csv` and defaults to `json` and a `explode` parameter that can be set to `yes` when
`format` is `csv` to expand the parameters and extras columns into their own columns.

## How it works

Both the `/download` and `/view` endpoints require a `portal_token` parameter.  The
`portal_token` parameter is a signed JWT token generated by the portal whose payload
looks like the following:

```
{
  "exp": 1490876553,
  "uid": 1777,
  "offering_info_url": "https://learn.concord.org/api/v1/offerings/4164"
}
```

The log puller validates and decodes the token.  To validate the `JWT_HMAC_SECRET` environment variable
must be set on Heroku *and* be the same as the secret on the portal.  Once validated and decoded a server side
get to offering_info_url is made, passing a header that looks like:

```
Authorization: Bearer/JWT <portal_token>
```

The result of the get to offering_info_url looks like this:

```
{
  "teacher": "John Chamberlain",
  "clazz": "Intro to Electronics 4",
  "clazz_id": 2279,
  "activity": "Teaching Teamwork - Three Resistors Field Test",
  "activity_url": "https://authoring.concord.org/activities/6833",
  "students": [
    {
      "name": "John Master",
      "username": "jmaster",
      "user_id": 41668,
      "started_activity": true,
      "endpoint_url": "https://learn.concord.org/dataservice/external_activity_data/8610f5fa-51b7-40de-a35c-aef6ff94347c"
    },
    {
      "name": "John master2",
      "username": "jmaster2",
      "user_id": 41727,
      "started_activity": true,
      "endpoint_url": "https://learn.concord.org/dataservice/external_activity_data/89901b1e-5b7b-4d9c-bc73-5372e767a9c4"
    },
    {
      "name": "John Master3",
      "username": "jmaster3",
      "user_id": 41728,
      "started_activity": true,
      "endpoint_url": "https://learn.concord.org/dataservice/external_activity_data/671dc86e-b86d-4a32-92d8-3e27a56651f7"
    }
  ]
}
```

The code then looks at the `activity_url` and validates that it ends with `/activities/<digits>` and then pulls the
digits out to get the activity id.  All other urls are rejects with an error message.

Once the activity id is parsed the code then validates that at the students array has at least one student with a
non-empty `endpoint_url`.  If no `endpoint_url` values are found then the code rejects the request with an error message.

Now with the activity id and at least one endpoint url in place a query is made to the shared cc-log-manager database
with the application name set to `LARA-log-poc`, the activity set to `activity: <activity id>` and a filter on the
`run_remote_endpoint` in the extras JSON object set to the student endpoints extracted in the offering info.

The results of that query are either streamed one row at a time (to save memory) when the view endpoint it used or
downloaded as a file if the download option is used.

## Development

Install Docker and make sure that docker-compose is installed too (it should be part of the standard Docker installation).

```
git clone git@github.com:concord-consortium/log-puller.git
cd log-puller
docker-compose up 
```

Now open your browser to http://localhost:5000/portal-report-tester.

If you're using Dinghy HTTP Proxy (https://github.com/concord-consortium/rigse/blob/master/docs/docker.md#setting-up-a-dns-and-proxy-to-avoid-port-conflicts), 
you can also go to http://app.log-puller.docker/portal-report-tester.  


## License

log-puller is Copyright 2017 (c) by the Concord Consortium and is distributed under the [MIT license](http://www.opensource.org/licenses/MIT).

