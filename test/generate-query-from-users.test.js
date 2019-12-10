const generateQueryFromUsers = require("../generate-query-from-users");

const users = [
  {id: 1, login: "doug", first_name: "Doug", last_name: "Martin"},
  {id: 2, login: "scott", first_name: "Scott", last_name: "Cytacki"},
]
const runnables = [
  {id: 1, lara_id: 1000, url: "http://authoring.concord.org/activities/1000", name: "First Activity", source_type: "LARA"},
  {id: 2, lara_id: 1001, url: "http://authoring.concord.org/activities/1001", name: "Second Activity", source_type: "LARA"}
]

describe("generateQueryFromUsers", () => {

  test("should handle an empty query", () => {
    const params = {domain: "", users: [], runnables: [], start_date: null, end_date: null}
    const result = {queryMarkers: "", queryValues: []};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

  test("should handle start_date query", () => {
    const params = {domain: "", users: [], runnables: [], start_date: "01/02/19", end_date: null}
    const result = {queryMarkers: "time >= $1", queryValues: ["19-01-02"]};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

  test("should handle end_date query", () => {
    const params = {domain: "", users: [], runnables: [], start_date: null, end_date: "01/02/19"}
    const result = {queryMarkers: "time <= $1", queryValues: ["19-01-02"]};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

  test("should handle a users query", () => {
    const params = {domain: "example.com", users, runnables: [], start_date: null, end_date: null}
    const result = {queryMarkers: "(username = $1 OR username = $2)", queryValues: ["1@example.com", "2@example.com"]};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

  test("should handle a runnables query", () => {
    const params = {domain: "example.com", users: [], runnables, start_date: null, end_date: null}
    const result = {queryMarkers: "(activity = $1 OR activity = $2)", queryValues: ["activity: 1000", "activity: 1001"]};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

  test("should handle a combined query", () => {
    const params = {domain: "example.com", users: users, runnables, start_date: "01/02/19", end_date: "03/04/19"}
    const result = {queryMarkers: "(username = $1 OR username = $2) AND (activity = $3 OR activity = $4) AND time >= $5 AND time <= $6", queryValues: ["1@example.com", "2@example.com", "activity: 1000", "activity: 1001", "19-01-02", "19-03-04"]};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

});