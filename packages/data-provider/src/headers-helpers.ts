import axios from 'axios';

export function setAcceptLanguageHeader(value: string): void {
  axios.defaults.headers.common['Accept-Language'] = value;
}

export function setTokenHeader(token: string | undefined) {
  if (token === undefined) {
    delete axios.defaults.headers.common['Authorization'];
  } else {
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
  }
}

export function getTokenHeader(): string | undefined {
  const authorization = axios.defaults.headers.common['Authorization'];
  return typeof authorization === 'string' ? authorization : undefined;
}
