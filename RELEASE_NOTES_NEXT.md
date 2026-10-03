## What's new

- **The Bridge no longer grows in memory the longer it runs.** Each time an AI app connected, the Bridge kept that connection's state, even after the app quit or restarted without saying goodbye (most do). Over a day or two this could add up to several gigabytes. Connections left idle for an hour are now closed, and only a small number of idle ones are kept. An AI app that comes back after a long pause simply reconnects on its own, so nothing changes for you.
