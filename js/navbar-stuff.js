    // Mobile nav
    const ham = document.getElementById('bk-hamburger');
    const mob = document.getElementById('bk-mobile-nav');
    if (ham && mob) {
      ham.addEventListener('click', () => mob.classList.toggle('open'));
      mob.querySelectorAll('a').forEach(a => a.addEventListener('click', () => mob.classList.remove('open')));
    }

    // Simple IntersectionObserver reveal (replaces GSAP ScrollTrigger on tool page)
    const revealEls = document.querySelectorAll('.reveal');
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
      }, { threshold: 0.1 });
      revealEls.forEach(el => io.observe(el));
    } else {
      revealEls.forEach(el => el.classList.add('visible'));
    }

        // Desktop tools dropdown
    var toolsBtn  = document.getElementById('tools-dropdown-btn');
    var toolsDrop = document.getElementById('tools-dropdown');
    if (toolsBtn && toolsDrop) {
      toolsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = toolsDrop.classList.toggle('open');
        toolsBtn.classList.toggle('open', open);
      });
      // Close when clicking anywhere outside
      document.addEventListener('click', function () {
        toolsDrop.classList.remove('open');
        toolsBtn.classList.remove('open');
      });
      // Prevent clicks inside dropdown from closing it
      toolsDrop.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    // Mobile tools sub-menu
    var mobileToolsBtn = document.getElementById('bk-mobile-tools-btn');
    var mobileToolsSub = document.getElementById('bk-mobile-tools-sub');
    if (mobileToolsBtn && mobileToolsSub) {
      mobileToolsBtn.addEventListener('click', function () {
        var open = mobileToolsSub.classList.toggle('open');
        mobileToolsBtn.classList.toggle('open', open);
      });
    }