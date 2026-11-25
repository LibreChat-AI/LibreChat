/**
 * Lua CJSON cannot distinguish decoded empty arrays from empty objects. These helpers protect
 * structural empty arrays with a collision-free string sentinel before decoding, then restore
 * them after encoding. The scanner skips JSON string contents, so literal `[]` text is unchanged.
 */
export const PRESERVE_EMPTY_ARRAYS_LUA = `
local function emptyArraySentinel(...)
  local sentinel = '__librechat_empty_array__'
  while true do
    local collision = false
    for index = 1, select('#', ...) do
      local json = select(index, ...)
      if json and string.find(json, sentinel, 1, true) then
        collision = true
        break
      end
    end
    if not collision then return sentinel end
    sentinel = sentinel .. '_'
  end
end

local function protectEmptyArrays(json, sentinel)
  local output = {}
  local inString = false
  local escaped = false
  local index = 1
  while index <= #json do
    local character = string.sub(json, index, index)
    if inString then
      table.insert(output, character)
      if escaped then
        escaped = false
      elseif string.byte(character) == 92 then
        escaped = true
      elseif character == '"' then
        inString = false
      end
      index = index + 1
    elseif character == '"' then
      inString = true
      table.insert(output, character)
      index = index + 1
    elseif character == '[' then
      local closeIndex = index + 1
      while closeIndex <= #json do
        local candidate = string.sub(json, closeIndex, closeIndex)
        if not string.find(' \\t\\r\\n', candidate, 1, true) then break end
        closeIndex = closeIndex + 1
      end
      if string.sub(json, closeIndex, closeIndex) == ']' then
        table.insert(output, '"' .. sentinel .. '"')
        index = closeIndex + 1
      else
        table.insert(output, character)
        index = index + 1
      end
    else
      table.insert(output, character)
      index = index + 1
    end
  end
  return table.concat(output)
end

local function restoreEmptyArrays(json, sentinel)
  local restored = string.gsub(json, '"' .. sentinel .. '"', '[]')
  return restored
end
`;
