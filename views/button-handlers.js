(function () {
  var form = $('form');
  var queryResult = $('#queryResult');
  var running = $('#running');
  var buttons = $(".buttons > input");
  var countBtn = $('input[name="count"]');
  var debugBtn = $('input[name="debug"]');
  var debugInfo = $('#debug-info');
  var expandNote = $('#expandNote');
  var expandedNote = $('#expandedNote');

  function querying(runningQuery) {
    if (runningQuery) {
      running.show();
    } else {
      running.hide();
    }
    buttons.attr("disabled", runningQuery);
  }

  countBtn.on('click', function (e) {
    e.preventDefault(); // do not submit form
    querying(true)
    queryResult.html("");
    $.ajax({
      method: 'POST',
      data: form.serialize() + "&count=true",
      success: function (resp) {
        console.log(resp);
        queryResult.html($('<b>').text('Query will return ' + resp.result + ' logs.'));
      },
      error: function (jqXHR, textStatus, errorThrown) {
        const error = (jqXHR.responseJSON && jqXHR.responseJSON.error) || '';
        console.error(errorThrown, error);
        window.alert(`Request has failed.\n${errorThrown}: ${error}\n`);
      }
    }).always(function () {
      querying(false)
    });
  });

  debugBtn.on('click', function (e) {
    e.preventDefault(); // do not submit form
    querying(true)
    $.ajax({
      method: 'POST',
      data: form.serialize() + "&debug=true",
      success: function (resp) {
        console.log(resp);
        debugInfo.html(JSON.stringify(resp.result, null, 2)).show();
      },
      error: function (jqXHR, textStatus, errorThrown) {
        const error = (jqXHR.responseJSON && jqXHR.responseJSON.error) || '';
        console.error(errorThrown, error);
        window.alert(`Request has failed.\n${errorThrown}: ${error}\n`);
      }
    }).always(function () {
      querying(false)
    });
  });

  expandNote.on('click', function (e) {
    e.preventDefault();
    expandedNote.toggle();
  });

})();
