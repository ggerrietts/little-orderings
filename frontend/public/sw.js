self.addEventListener('push', (event) => {
  let data = { title: 'Little Orderings', body: 'You have updates', url: '/' }
  if (event.data) {
    try {
      data = event.data.json()
    } catch {
      // fall back to the default above
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      data: { url: data.url },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/'
  // The push payload's url is always relative (e.g. "/projects/5"), but
  // client.url is always absolute (e.g. "https://todo.gerrietts.net/projects/5").
  // Resolve against our own origin before comparing, or the "focus an
  // already-open tab" branch below can never match.
  const targetUrl = new URL(url, self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === targetUrl && 'focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})
