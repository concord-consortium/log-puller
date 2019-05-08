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
      queryValues.push(`activity: ${runnable.lara_id}`);
      activityMarkers.push(`activity = $${queryValues.length}`)
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

  if (queryMarkersParts.length > 0) {
    queryMarkersParts.unshift("(application = 'LARA-log-poc')")
  }

  const queryMarkers = queryMarkersParts.join(" AND ");

  return { queryMarkers, queryValues };
}
