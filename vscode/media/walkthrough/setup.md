# Look at the agent setup

**Agent Setup**, in the Imprimatur side bar, lists everything that shapes what the agent does:

- instruction files and @imports
- settings and permissions
- hooks, with how long each takes and how much text it adds
- skills, plugins and MCP servers, with their source and version
- what the last session was given

The **Checklist** at the top shows what needs doing: an outdated plugin, a skill that changed upstream, a broken file, an open recommendation. **Fix it** hands an item to Claude in the background. You see the diff before anything changes.

**Recommendations** runs the agent setup audit (agnix) and a project review. Each finding is kept as a record you can apply or dismiss.
