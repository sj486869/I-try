# AWS EC2 Setup Guide for WebOS Video Media Server

This guide will walk you through deploying your standalone Node.js video server to an AWS EC2 instance. 

Since this is a media server dealing with large video files, we will set up **Nginx** as a reverse proxy, **PM2** to keep the app running in the background, and **Certbot** for free HTTPS (SSL).

---

## 1. Launching the EC2 Instance

1. Go to the AWS EC2 Console and click **Launch Instance**.
2. **Name:** `webos-media-server` (or whatever you prefer).
3. **AMI (OS):** Select **Ubuntu 22.04 LTS** (or 24.04 LTS).
4. **Instance Type:** `t3.micro` or `t3.small` (Free tier eligible `t2.micro` works, but network performance might bottleneck large video streaming).
5. **Key Pair:** Create a new key pair (e.g., `webos-key.pem`) and download it. You'll need this to SSH into the server.
6. **Storage:** Standard is 8GB. **Increase this to at least 20GB-50GB** depending on how many videos you plan to store.

### Security Group Settings (Crucial)
Ensure you allow the following inbound traffic in your Security Group:
- **SSH (Port 22):** Anywhere (or your IP)
- **HTTP (Port 80):** Anywhere
- **HTTPS (Port 443):** Anywhere
*(Note: We will not expose port 3001 directly to the internet; Nginx will proxy port 80/443 to 3001 locally.)*

---

## 2. Connect to Your Instance

Open your terminal and SSH into your new EC2 instance using the key you downloaded:

```bash
chmod 400 path/to/webos-key.pem
ssh -i path/to/webos-key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

---

## 3. Install Required Software

Update the server and install Node.js, NPM, Nginx, and PM2.

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (v20)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Nginx
sudo apt install -y nginx

# Install PM2 globally
sudo npm install -g pm2
```

---

## 4. Download Code from GitHub (Git Clone)

EC2 server par code download karne ke liye `git clone` ka use karein. Apne terminal mein yeh commands run karein:

```bash
# Apne home folder me jayein
cd ~

# GitHub se apna code download karein (Niche apna repository URL daalein)
git clone https://github.com/your-username/your-repo-name.git

# Clone hone ke baad, repo ke folder me jayein (Yahan 'your-repo-name' ko apne folder se badle)
cd your-repo-name

# Aur uske baad 'video-server' folder ke andar jayein
cd video-server
```

---

## 5. Setup & Start the Application

Install the dependencies and start the app using PM2 to ensure it restarts automatically if the server reboots.

```bash
# Install dependencies
npm install

# Create a .env file (optional, but recommended)
echo "PORT=3001" > .env
echo "CORS_ORIGIN=*" >> .env
# echo "AUTH_TOKEN=your_secret_token" >> .env (Uncomment if using auth)

# Start the server with PM2
pm2 start server.js --name "webos-media-server"

# Setup PM2 to start on system boot
pm2 startup ubuntu
# (Run the command PM2 outputs on the screen)
pm2 save
```

---

## 6. Configure Nginx (Reverse Proxy)

Nginx will catch requests on port 80 (HTTP) and route them to our Node.js app on port 3001. We also need to configure Nginx to accept large file uploads.

Create a new Nginx configuration file:

```bash
sudo nano /etc/nginx/sites-available/media-server
```

Paste the following configuration (replace `your_domain_or_ip` with your EC2 Public IP or your custom domain name):

```nginx
server {
    listen 80;
    server_name your_domain_or_ip;

    # Allow large file uploads (e.g., 5GB max)
    client_max_body_size 5000M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # WebSocket support (for Watch Together)
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

Enable the configuration and restart Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/media-server /etc/nginx/sites-enabled/
# Remove default nginx config to prevent conflicts
sudo rm /etc/nginx/sites-enabled/default
# Test nginx config
sudo nginx -t
# Restart nginx
sudo systemctl restart nginx
```

---

## 7. Setup HTTPS / SSL (Optional but Highly Recommended)

If you have a custom domain pointing to your EC2 instance (e.g., `media.yourdomain.com`), you can get a free SSL certificate using Let's Encrypt. If you are just using the raw IP address, skip this step.

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Request and install certificate
sudo certbot --nginx -d media.yourdomain.com
```

Certbot will automatically configure Nginx to force HTTPS.

---

## 8. Connect Your WebOS Frontend

Now that your backend is running in the cloud, open your WebOS Frontend settings and set the **Media Server** URL to:

- `http://YOUR_EC2_PUBLIC_IP` (If no domain/SSL)
- `https://media.yourdomain.com` (If you setup a domain and SSL)

*(Note: Never add a trailing slash or `/health` at the end! Just the base URL).*

Click **Test** and you should see a successful connection! 🚀
