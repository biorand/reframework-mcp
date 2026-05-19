-- mcp_bridge.lua
-- Place in: reframework/autorun/mcp_bridge.lua
--
-- Polls for reframework/data/mcp_input.lua every second.
-- When found, executes its contents in a sandboxed environment,
-- captures print() output + return values + errors,
-- writes everything to reframework/data/mcp_output.txt,
-- then deletes the input file so it doesn't re-run.

local INPUT_FILE     = "mcp_input.lua"
local OUTPUT_FILE    = "mcp_output.txt"
local CHECK_INTERVAL = 60 -- frames between polls (~1 s at 60 fps)

local frame_count    = 0

-- ── helpers ──────────────────────────────────────────────────────────────────

-- Serialize any value to a human-readable string (handles tables recursively).
local function serialize(val, depth)
    depth = depth or 0
    local indent = string.rep("  ", depth)

    local t = type(val)
    if t == "nil" then
        return "nil"
    elseif t == "boolean" or t == "number" then
        return tostring(val)
    elseif t == "string" then
        return string.format("%q", val)
    elseif t == "table" then
        if depth > 4 then return "{...}" end -- guard against deep nesting
        local parts = {}
        for k, v in pairs(val) do
            local key_str = (type(k) == "string")
                and k
                or ("[" .. tostring(k) .. "]")
            parts[#parts + 1] = indent .. "  " .. key_str .. " = " .. serialize(v, depth + 1)
        end
        if #parts == 0 then return "{}" end
        return "{\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "}"
    else
        -- userdata, function, thread, etc.
        return "<" .. t .. ": " .. tostring(val) .. ">"
    end
end

-- Run a Lua source string in a restricted env, return {output, error}.
local function execute_script(source)
    local captured_lines = {}

    -- Sandboxed environment that shares the REFramework globals but
    -- redirects print() so we can capture it.
    local env = setmetatable({
        print    = function(...)
            local args = { ... }
            local parts = {}
            for i = 1, #args do
                parts[i] = serialize(args[i])
            end
            captured_lines[#captured_lines + 1] = table.concat(parts, "\t")
        end,
        tostring = tostring,
        tonumber = tonumber,
        type     = type,
        pairs    = pairs,
        ipairs   = ipairs,
        next     = next,
        select   = select,
        unpack   = table.unpack or unpack,
        error    = error,
        pcall    = pcall,
        xpcall   = xpcall,
        assert   = assert,
        string   = string,
        table    = table,
        math     = math,
        -- Expose REFramework APIs so scripts can actually use them:
        sdk      = sdk,
        re       = re,
        log      = log,
        fs       = fs,
        json     = json,
        imgui    = imgui,
        draw     = draw,
        -- Expose full _G for power users (they can break their own sandbox).
        _G       = _G,
    }, { __index = _G })

    local chunk, load_err = load(source, "mcp_input", "t", env)
    if not chunk then
        return nil, "Syntax/load error: " .. tostring(load_err)
    end

    local ok, result = pcall(chunk)

    local output_text = ""
    if #captured_lines > 0 then
        output_text = table.concat(captured_lines, "\n") .. "\n"
    end

    if not ok then
        return output_text, "Runtime error: " .. tostring(result)
    end

    -- If the chunk returned a value, append it.
    if result ~= nil then
        output_text = output_text .. "=> " .. serialize(result) .. "\n"
    end

    return output_text, nil
end

-- ── main poll loop ────────────────────────────────────────────────────────────

re.on_frame(function()
    frame_count = frame_count + 1
    if frame_count < CHECK_INTERVAL then return end
    frame_count = 0

    -- Try to read the input file.
    local source = fs.read(INPUT_FILE)
    if source == nil or source == "" then return end

    log.debug("[mcp_bridge] mcp_input.lua detected - executing...")

    -- Build the output header.
    local timestamp   = os.date("%Y-%m-%d %H:%M:%S")
    local header      = "-- mcp_output.txt | executed: " .. timestamp .. "\n"
        .. string.rep("-", 60) .. "\n"

    local output, err = execute_script(source)

    local body        = ""
    if output and output ~= "" then
        body = body .. output
    end
    if err then
        body = body .. "\n[ERROR]\n" .. err .. "\n"
    end
    if body == "" then
        body = "(script produced no output)\n"
    end

    local full_output = header .. body

    -- Write result.
    fs.write(OUTPUT_FILE, full_output)
    log.debug("[mcp_bridge] wrote " .. OUTPUT_FILE)

    -- Erase the input file so it won't re-run next poll.
    fs.write(INPUT_FILE, "")

    log.debug("[mcp_bridge] done.")
end)

log.debug("[mcp_bridge] loaded - polling every " .. CHECK_INTERVAL .. " frames for " .. INPUT_FILE)
