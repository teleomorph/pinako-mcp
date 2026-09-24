## What's new

- **AI clients can ask for just the structure of your tabs.** `get_tree` and `get_library` take a new `containers_only` option that returns windows, Window Groups and folders without every tab, so questions like "how many windows do I have?" are fast and cheap. `get_tree_summary` no longer counts incognito tabs.
- **The installer now registers the Bridge under the name "Pinako" in every AI app**, and quietly renames the old lowercase entry when you re-install.
- The service binary can run an installed Pinako hook for Claude Code and install or remove that plugin; the installers use it.
- More reliable connection to the browser: the Bridge stays awake only while the extension has work queued, and logs cleanly when the browser closes the connection.

Housekeeping: tool descriptions brought in line with the code.
