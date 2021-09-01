const generateQueryFromUsers = require("../generate-query-from-users");

const users = [
  {id: 1, login: "doug", first_name: "Doug", last_name: "Martin"},
  {id: 2, login: "scott", first_name: "Scott", last_name: "Cytacki"},
]
const runnables = [
  {id: 1, url: "http://authoring.concord.org/activities/1000", name: "LARA Activity", source_type: "LARA"},
  {id: 2, url: "http://authoring.concord.org/sequences/1001", name: "LARA Sequence", source_type: "LARA"},
  {id: 3, url: "https://activity-player.concord.org/?activity=https%3A%2F%2Fauthoring.concord.org%2Fapi%2Fv1%2Factivities%2F1002.json", name: "AP Activity", source_type: "ActivityPlayer"},
  {id: 4, url: "https://activity-player.concord.org/?sequence=https://authoring.concord.org/api/v1/sequences/1003.json", name: "AP Sequence", source_type: "ActivityPlayer"}
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
    const result = {
      queryMarkers: "(activity = $1 OR activity = $2 OR activity = $3 OR activity = $4 OR activity = $5 OR activity = $6)",
      queryValues: ["activity: 1000", "sequence: 1001", "activity: 1002", "https://authoring.concord.org/api/v1/activities/1002.json", "sequence: 1003", "https://authoring.concord.org/api/v1/sequences/1003.json"]
    };
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

  test("should handle a combined query", () => {
    const params = {domain: "example.com", users: users, runnables, start_date: "01/02/19", end_date: "03/04/19"}
    const result = {
      queryMarkers: "(username = $1 OR username = $2) AND (activity = $3 OR activity = $4 OR activity = $5 OR activity = $6 OR activity = $7 OR activity = $8) AND time >= $9 AND time <= $10",
      queryValues: ["1@example.com", "2@example.com", "activity: 1000", "sequence: 1001", "activity: 1002", "https://authoring.concord.org/api/v1/activities/1002.json", "sequence: 1003", "https://authoring.concord.org/api/v1/sequences/1003.json", "19-01-02", "19-03-04"]};
    expect(generateQueryFromUsers(params)).toMatchObject(result);
  });

});
