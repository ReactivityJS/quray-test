const currentPathName = location.pathname.replace(/index\.html$/u, '')
document.querySelectorAll('[data-nav-link]').forEach((linkElement) => {
  const linkPath = new URL(linkElement.getAttribute('href'), location.href).pathname.replace(/index\.html$/u, '')
  if (linkPath === currentPathName) linkElement.classList.add('is-current')
})
