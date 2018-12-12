(function () {
  var form = $('form');
  var container = $('#count-btn-container');
  var spinner = $('<div>Please wait <i class="fas fa-spinner fa-pulse"></i></div>');
  var result = $('<b>');
  var countBtn = $('input[name="count"]');

  // Attach a delegated event handler, so it doesn't get messed up when we remove and re-add button.
  container.on('click', 'input', function (e) {
    e.preventDefault(); // do not submit form
    $.ajax({
      method: 'POST',
      data: form.serialize() + "&count=true",
      success: function (resp) {
        console.log(resp);
        result.text('Query will return ' + resp.result + ' logs.')
        container.append(result);
      },
      error: function (jqXHR, textStatus, errorThrown) {
        const error = (jqXHR.responseJSON && jqXHR.responseJSON.error) || '';
        console.error(errorThrown, error);
        window.alert(`Request has failed.\n${errorThrown}: ${error}\n`);
        container.append(countBtn);
      }
    }).always(function () {
      spinner.remove();
    });

    countBtn.remove();
    container.append(spinner);
  });
})();
