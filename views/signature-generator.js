/*
  NOTE: initially the Crypto.js library was used but it does not correctly generate
        HMACs for messages that contain newlines so the signature generation
        was moved to the server side.
*/
(function () {
  var form = $('form');
  var json = $('textarea[name="json"]');
  var signature = $('input[name="signature"]');
  var secret = $('input[name="secret"]');

  var SECRET_KEY = "secret"

  secret.val(window.localStorage.getItem(SECRET_KEY) || "")

  function generateSignature() {
    var secretValue = secret.val();
    if (secretValue.length > 0) {
      $.ajax({
        method: 'POST',
        data: form.serialize() + "&getSignature=true",
        success: function (resp) {
          signature.val(resp.result);
        },
        error: function (jqXHR, textStatus, errorThrown) {
          const error = (jqXHR.responseJSON && jqXHR.responseJSON.error) || '';
          console.error(errorThrown, error);
          window.alert(`Request has failed.\n${errorThrown}: ${error}\n`);
        }
      })
    }
  }

  function signatureChanged() {
    generateSignature();
    window.localStorage.setItem(SECRET_KEY, secret.val())
  }

  json.on("keyup", generateSignature);
  json.on("change", generateSignature);

  secret.on("keyup", signatureChanged);
  secret.on("change", signatureChanged);

})();
