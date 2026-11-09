function handler(event) {
  var request = event.request;

  if (request.uri === '/donate') {
    request.uri = '/donate.html';
  } else if (request.uri === '/store') {
    request.uri = '/store.html';
  } else if (request.uri === '/slideshow') {
    request.uri = '/slideshow.html';
  } else if (request.uri === '/slideshow/play') {
    request.uri = '/slideshow-play.html';
  }

  return request;
}
