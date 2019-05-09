/*
  source json:

  {
    query: [
      "and", ["=", "b", 3], ["or", ["=", "a", 1], ["=", "a", 2] ]
    ]
  }

  should result in:

  queryMarkers: "((b = $1) and ((a = $2) or (a = $3)))"
  queryValues: [3, 1, 2]
*/

const validateIndexedColumn = (column) => {
  if (["activity", "application", "event", "run_remote_endpoint", "session", "time", "username"].indexOf(column) === -1) {
    throw new Error(`Non-indexed column specified: ${column}`);
  }
  return column;
}

const binaryOp = (upperOp, subQuery, values) => {
  if (subQuery.length !== 2) {
    throw new Error(`${upperOp} requires two parameters`);
  }
  const left = subQuery.shift();
  const right = subQuery.shift();
  return `(${generate(left, values)} ${upperOp} ${generate(right, values)})`;
};

const inOp = (upperOp, subQuery, values) => {
  if (subQuery.length !== 1) {
    throw new Error(`${upperOp} requires one parameter`);
  }
  const inParam = subQuery.shift();
  if (!Array.isArray(inParam) || (inParam.length !== 2)) {
    throw new Error(`${upperOp} query parameter requires a two element array`)
  }
  const joiner = upperOp === "IN-AND" ? "AND" : "OR";
  const column = validateIndexedColumn(inParam.shift());
  const inValues = inParam.shift();
  const inQuery = inValues.map((value) => {
    values.push(value)
    return `(${column} = $${values.length})`;
  }).join(` ${joiner} `);
  return `(${inQuery})`;
}

const expression = (upperOp, subQuery, values) => {
  let column, value, op;
  if (subQuery.length === 1) {
    op = "=";
    column = upperOp.toLowerCase();
    value = subQuery[0];
  }
  else if (subQuery.length === 2) {
    op = upperOp;
    column = subQuery[0];
    value = subQuery[1];
  }
  else {
    throw new Error(`Invalid expression: ${JSON.stringify([upperOp].concat(subQuery))}`);
  }
  validateIndexedColumn(column);
  values.push(value)
  return `(${column} ${op} $${values.length})`;
}

const generate = (subQuery, values) => {
  const op = (subQuery.shift() || "").trim();
  if (op === "") {
    throw new Error("Missing operator!");
  }

  const upperOp = op.toUpperCase();
  switch (upperOp) {
    case "AND":
    case "OR":
      return binaryOp(upperOp, subQuery, values);

    case "IN":
    case "IN-OR":
    case "IN-AND":
      return inOp(upperOp, subQuery, values);

    default:
      return expression(upperOp, subQuery, values);
  }
}

module.exports = (query) => {
  const queryValues = [];
  const queryMarkers = generate(query.slice(), queryValues);
  return { queryMarkers, queryValues }
}
