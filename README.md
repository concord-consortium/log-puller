# log-puller

This app runs on Heroku and points to the cc-log-manager app's database.  Its purpose
is to allow for filtered log data queries based on the user's portal credentials passed as a json web token.

Currently the app exposes two endpoints: `/download` and `/view`.  The both run the same
query but `/download` sets the Content-Disposition header so the result of the query
is downloaded in the browser whereas `/view` just streams the result to the browser.

## How it works

Both the `/download` and `/view` endpoints require a `portal_token` parameter.  The
`portal_token` parameter is a signed JWT token generated by the portal whose payload
looks like the following:

```
{
  "exp": 1490876553,
  "uid": 1777,
  "claims": {
    "offering_info_url": "https://learn.concord.org/api/v1/offerings/4164"
  }
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

## License

log-puller is Copyright 2017 (c) by the Concord Consortium and is distributed under the [MIT license](http://www.opensource.org/licenses/MIT).

