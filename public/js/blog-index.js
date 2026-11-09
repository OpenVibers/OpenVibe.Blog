'use strict';
/**
 * The index's next page (the official blog's home and /devblog): as a reader nears the bottom, the
 * next page's art cards are added in place. The "Next page" link stays a real link — a crawler, a
 * reader without script or a failed fetch still moves to the same page.
 */
(function () {
    var next = document.querySelector('.bh-next');
    var grid = document.querySelector('.bh-artcards');
    if (!next || !grid || !('IntersectionObserver' in window) || !window.fetch) return;
    var busy = false;
    function load() {
        if (busy || !next) return;
        var href = next.getAttribute('href');
        if (!href) return;
        busy = true;
        fetch(href, { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (html) {
                if (!html) return;
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var cards = doc.querySelectorAll('.bh-artcards > li');
                for (var i = 0; i < cards.length; i++) grid.appendChild(document.importNode(cards[i], true));
                var following = doc.querySelector('.bh-next');
                if (following) next.setAttribute('href', following.getAttribute('href'));
                else { next.parentNode.removeChild(next); io.disconnect(); }
            })
            .catch(function () { /* the link is still there */ })
            .then(function () { busy = false; });
    }
    var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) load();
    }, { rootMargin: '600px 0px' });
    io.observe(next);
})();
