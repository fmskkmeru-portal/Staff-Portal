/* If app.js (or the Firebase library it imports) fails to load — usually a
   bad connection — say so instead of spinning forever. */
setTimeout(function () {
  if (window.__portalStarted) return;
  var t = document.getElementById("loadingText");
  if (t) t.innerHTML = "The portal could not load. Check your internet connection, then " +
    '<a href="./">reload the page</a>.';
}, 12000);
