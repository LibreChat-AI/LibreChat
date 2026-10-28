export function isJson(str: string) {
  try {
    JSON.parse(str);
  } catch {
    return false;
  }
  return true;
}

export function formatJSON(json: string) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function extractJson(text: string) {
  let openBraces = 0;
  let startIndex = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (text[i] === '\\') {
        escaped = true;
      } else if (text[i] === '"') {
        inString = false;
      }
      continue;
    }
    if (text[i] === '"' && openBraces > 0) {
      inString = true;
    } else if (text[i] === '{') {
      if (openBraces === 0) {
        startIndex = i;
      }
      openBraces++;
    } else if (text[i] === '}' && openBraces > 0) {
      openBraces--;
      if (openBraces === 0 && startIndex !== -1) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return '';
}
