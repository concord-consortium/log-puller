const { URL } = require("url");

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
      // AP activities seem to use encoded form while AP sequences don't. It might be a bug, but support both
      // versions just in case. Example URLs:
      // - LARA Activity: 'https://authoring.concord.org/activities/1'
      // - AP Activity: 'https://activity-player.concord.org/branch/master/?activity=https%3A%2F%2Fapp.lara.docker%2Fapi%2Fv1%2Factivities%2F1.json'
      // - AP Sequence: 'https://activity-player.concord.org/branch/master/?sequence=https://app.lara.docker/api/v1/sequences/1.json'
      const activityMatch = runnable.url.match(/activities(%2F|\/)(\d+)/);
      const sequenceMatch = runnable.url.match(/sequences(%2F|\/)(\d+)/);
      const idGroupIdx = 2; // the first group is (%2F|\/)

      // LARA and Portal Report log events with an `activity` property value equal to `activity: <id>` and `sequence: <id>`.
      // For example: "activity: 20874"
      if (activityMatch || sequenceMatch) {
        if (activityMatch) {
          queryValues.push(`activity: ${activityMatch[idGroupIdx]}`);
        }
        else {
          queryValues.push(`sequence: ${sequenceMatch[idGroupIdx]}`);
        }
        activityMarkers.push(`activity = $${queryValues.length}`)
      }
      // Activity Player logs events with an `activity` property value equal to activity or sequence JSON URL.
      // For example: "https://authoring.staging.concord.org/api/v1/activities/20874.json"
      const url = new URL(runnable.url);
      const activityOrSequenceUrlParam = url.searchParams.get("sequence") || url.searchParams.get("activity");
      if (activityOrSequenceUrlParam) {
        queryValues.push(activityOrSequenceUrlParam);
        activityMarkers.push(`activity = $${queryValues.length}`)
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
