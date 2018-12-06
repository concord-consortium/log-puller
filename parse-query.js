const parseLogManagerQuery = (queryJson) => {
  const endpointValues = [];
  const endpointMarkers = [];
  let endpointMarkerIndex = 1;
  queryJson.filter.forEach((filter) => {
    if (filter.key === 'run_remote_endpoint') {
      (filter.list || []).forEach((endpoint) => {
        endpointValues.push(endpoint);
        endpointMarkers.push('$' + endpointMarkerIndex++);
      });
    }
  });
  return { endpointValues, endpointMarkers };
}

const parseSimpleQuery = (queryJson) => {
  const endpointValues = [];
  const endpointMarkers = [];
  queryJson.run_remote_endpoints.forEach((endpoint, index) => {
    endpointValues.push(endpoint);
    endpointMarkers.push('$' + (index + 1));
  })
  return { endpointValues, endpointMarkers };
}

// Parses logs query. It supports either the old Log Manager format or the new, simplified query coming from Portal.
module.exports = (queryJson) => {
  if (queryJson.filter) {
    return parseLogManagerQuery(queryJson);
  } else if (queryJson.run_remote_endpoints) {
    return parseSimpleQuery(queryJson)
  } else {
    throw new Error('Unsupported query format - missing filter/run_remote_endpoints section in json parameter');
  }
}
