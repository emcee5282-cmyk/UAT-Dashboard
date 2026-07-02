# Paano mag-deploy sa VPS (mcwpay062026.com)

**Palagi sa Git Bash, hindi PowerShell.**

## 1. I-push ang code (kung meron kang git remote workflow)
```bash
git push
```

## 2. Build + upload (sa local machine mo)
```bash
MSYS_NO_PATHCONV=1 VPS_HOST=159.89.169.210 VPS_USER=root VPS_PATH=/root/UAT-Dashboard-release npm run deploy:package
```
Ito ang nagba-build, nagpapaketi, at nag-a-upload papunta sa `/root/UAT-Dashboard-release/release`.

## 3. I-restart ang live server (sa VPS)
```bash
ssh root@159.89.169.210 "pm2 restart dashboard"
```

Tapos na. I-check sa browser: https://mcwpay062026.com

---
**Kung kailangan i-verify muna bago i-restart ang live site** (opsyonal, para walang downtime kung may pagdududa):
```bash
ssh root@159.89.169.210 "cd /root/UAT-Dashboard-release/release && PORT=3001 nohup node server.js > /tmp/test.log 2>&1 & sleep 2 && curl -I http://localhost:3001/"
```
Kung 200 OK — ligtas mag-Step 3. Pagkatapos, patayin ang test process:
```bash
ssh root@159.89.169.210 "pkill -f PORT=3001"
```
