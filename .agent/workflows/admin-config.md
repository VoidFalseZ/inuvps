---
description: How to manage push notifications and update dialogs from admin config
---

# Admin Config Management

The backend uses a JSON config file to control notifications, update dialogs, and maintenance mode.

## Config File Location

On VPS: `/root/inuvps/cache/admin_config.json`

## How to Edit

// turbo-all

1. SSH into VPS
```bash
ssh root@31.97.48.130
```

2. Edit the config file
```bash
nano /root/inuvps/cache/admin_config.json
```

3. Save and exit (Ctrl+X, Y, Enter)

4. Changes take effect immediately (no restart needed!)

## Config Structure

```json
{
  "app_version": {
    "latest": "1.0.2",
    "minimum": "1.0.0",
    "force_update": false
  },
  "update_dialog": {
    "enabled": true,
    "title": "Update Available",
    "message": "Please update to the latest version!",
    "update_url": "https://play.google.com/store/apps/details?id=..."
  },
  "notifications": [
    {
      "id": "notif_001",
      "enabled": true,
      "title": "Welcome!",
      "message": "Thanks for using InuPoi!",
      "type": "info",
      "expires": "2025-12-31T23:59:59Z"
    }
  ],
  "maintenance": {
    "enabled": false,
    "message": "Server is under maintenance"
  }
}
```

## Common Tasks

### Show Update Dialog
Set `update_dialog.enabled` to `true`

### Push a Notification
Add to `notifications` array:
```json
{
  "id": "unique_id",
  "enabled": true,
  "title": "Title",
  "message": "Message content",
  "type": "info",
  "expires": "2025-12-31T23:59:59Z"
}
```

### Enable Maintenance Mode
Set `maintenance.enabled` to `true`

### Force App Update
Set `app_version.force_update` to `true`

## API Endpoints

- `GET /api/app_config` - Returns full config
- `GET /api/notifications` - Returns active notifications only
- `GET /api/update_dialog` - Returns update dialog config
