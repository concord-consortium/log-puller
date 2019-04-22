const translateQuery = require("../translate-query");

describe("translateQuery", () => {
  test("should translate simple = query", () => {
    const query = ["=", "event", "foo"];
    const result = {queryMarkers: "(event = $1)", queryValues: ["foo"]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate simple shortcut = query", () => {
    const query = ["event", "foo"];
    const result = {queryMarkers: "(event = $1)", queryValues: ["foo"]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate simple AND query", () => {
    const query = ["and", ["=", "event", "foo"], ["=", "event", 2]];
    const result = {queryMarkers: "((event = $1) AND (event = $2))", queryValues: ["foo", 2]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate simple OR query", () => {
    const query = ["or", ["=", "event", "foo"], ["=", "event", 2]];
    const result = {queryMarkers: "((event = $1) OR (event = $2))", queryValues: ["foo", 2]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate simple IN query", () => {
    const query = ["in", ["username", ["doug", "scott"]]];
    const result = {queryMarkers: "((username = $1) OR (username = $2))", queryValues: ["doug", "scott"]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate simple IN-OR query", () => {
    const query = ["in", ["username", ["doug", "scott"]]];
    const result = {queryMarkers: "((username = $1) OR (username = $2))", queryValues: ["doug", "scott"]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate simple IN-AND query", () => {
    const query = ["in-and", ["username", ["doug", "scott"]]];
    const result = {queryMarkers: "((username = $1) AND (username = $2))", queryValues: ["doug", "scott"]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  test("should translate complex query", () => {
    const query = ["and", ["or", ["=", "event", "foo"], ["=", "event", "bar"]], ["=", "event", 2]];
    const result = {queryMarkers: "(((event = $1) OR (event = $2)) AND (event = $3))", queryValues: ["foo", "bar", 2]};
    expect(translateQuery(query)).toMatchObject(result);
  })

  // fail tests

  test("fail with empty query", () => {
    expect(() => {
      translateQuery([])
    }).toThrowError("Missing operator!");
  });

  test("fail on invalid expression", () => {
    expect(() => {
      translateQuery(["foo"])
    }).toThrowError('Invalid expression: ["FOO"]');
  })

  test("fail on invalid column", () => {
    expect(() => {
      translateQuery(["=", "foo", "bar"])
    }).toThrowError("Non-indexed column specified: foo");
  })

  test("fail on too few AND parameters", () => {
    expect(() => {
      translateQuery(["and", "foo"])
    }).toThrowError("AND requires two parameters");
  })

  test("fail on too few OR parameters", () => {
    expect(() => {
      translateQuery(["or", "foo"])
    }).toThrowError("OR requires two parameters");
  })

  test("fail on too many AND parameters", () => {
    expect(() => {
      translateQuery(["and", "foo", "bar", "baz"])
    }).toThrowError("AND requires two parameters");
  })

  test("fail on too many OR parameters", () => {
    expect(() => {
      translateQuery(["or", "foo", "bar", "baz"])
    }).toThrowError("OR requires two parameters");
  })

  test("fail on too few IN parameters", () => {
    expect(() => {
      translateQuery(["in"])
    }).toThrowError("IN requires one parameter");
  })

  test("fail on too few IN-OR parameters", () => {
    expect(() => {
      translateQuery(["in-or"])
    }).toThrowError("IN-OR requires one parameter");
  })

  test("fail on too few IN-AND parameters", () => {
    expect(() => {
      translateQuery(["in-and"])
    }).toThrowError("IN-AND requires one parameter");
  })

  test("fail on IN parameter not being a two element array", () => {
    expect(() => {
      translateQuery(["in", "foo"])
    }).toThrowError("IN query parameter requires a two element array");
  })

  test("fail on IN-OR parameter not being a two element array", () => {
    expect(() => {
      translateQuery(["in-or", "foo"])
    }).toThrowError("IN-OR query parameter requires a two element array");
  })

  test("fail on IN-AND parameter not being a two element array", () => {
    expect(() => {
      translateQuery(["in-and", "foo"])
    }).toThrowError("IN-AND query parameter requires a two element array");
  })
});