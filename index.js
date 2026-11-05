const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configure Multer storage to keep original extension or default to .mp4
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueId = uuidv4().slice(0, 8); // short 8-character unique name
        cb(null, uniqueId + '.mp4');
    }
});
const upload = multer({ storage: storage });

// Serve static frontend files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded videos directly with .mp4 extension for Discord
app.use('/uploads', express.static(uploadDir));

// Handle video upload endpoint
app.post('/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video uploaded!' });
    }
    
    // Construct the full direct link for Discord
    const host = req.get('host');
    const protocol = req.protocol;
    const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
    
    res.json({ url: fileUrl });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
