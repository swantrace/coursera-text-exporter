chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id === chrome.runtime.id && message?.type === 'COURSE_CONTEXT') {
    const slug = location.pathname.match(/^\/learn\/([^/]+)/)?.[1];
    respond({ slug });
  }
});
