const convertTime = (fromCalendar) => {
  const [month, day, year, ...rest] = fromCalendar.split("/");
  return `${year}-${month}-${day}`;
}

// generates a query from the user report params
module.exports = (params) => {
  const {domain, users, runnables, start_date, end_date} = params;
  const queryValues = [];
  const queryMarkersParts = [];

  if (users) {
    const userMarkers = [];
    users.forEach((user) => {
      queryValues.push(`${user.id}@${domain}`);
      userMarkers.push(`username = $${queryValues.length}`)
    });
    if (userMarkers.length > 0) {
      queryMarkersParts.push(`(${userMarkers.join(" OR ")})`)
    }
  }

  if (runnables) {
    const activityMarkers = [];
    runnables.forEach((runnable) => {
      if (runnable.source_type === "LARA") {
        const activityMatch = runnable.url.match(/\/activities\/(\d+)$/);
        const sequenceMatch = runnable.url.match(/\/sequences\/(\d+)$/);
        if (activityMatch || sequenceMatch) {
          if (activityMatch) {
            queryValues.push(`activity: ${activityMatch[1]}`);
          }
          else {
            queryValues.push(`sequence: ${sequenceMatch[1]}`);
          }
          activityMarkers.push(`activity = $${queryValues.length}`)
        }
      }
    });
    if (activityMarkers.length > 0) {
      queryMarkersParts.push(`(${activityMarkers.join(" OR ")})`)
    }
  }

  if (start_date) {
    queryValues.push(convertTime(start_date));
    queryMarkersParts.push(`time >= $${queryValues.length}`);
  }
  if (end_date) {
    queryValues.push(convertTime(end_date));
    queryMarkersParts.push(`time <= $${queryValues.length}`);
  }

  const queryMarkers = queryMarkersParts.join(" AND ");

  return { queryMarkers, queryValues };
}
