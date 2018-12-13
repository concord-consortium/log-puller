const parseLogManagerQuery = (queryJson) => {
  const learners = [];
  queryJson.filter.forEach((filter) => {
    if (filter.key === 'run_remote_endpoint') {
      (filter.list || []).forEach((endpoint) => {
        learners.push({ run_remote_endpoint: endpoint });
      });
    }
  });
  return learners;
}

// Parses logs query. It supports either the old Log Manager format or the new, simplified query coming from Portal.
module.exports = (queryJson) => {
  if (queryJson.filter) {
    return parseLogManagerQuery(queryJson);
  } else if (queryJson.learners) {
    return queryJson.learners;
  } else {
    throw new Error('Unsupported query format - missing filter/learners section in json parameter');
  }
}
