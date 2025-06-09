require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;


app.use(express.json());


let serviceAccount;
try {
   
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } else {
       
        const serviceAccountPath = path.resolve(__dirname, 'firebase-service-account.json');
        if (fs.existsSync(serviceAccountPath)) {
            serviceAccount = require(serviceAccountPath);
        } else {
            throw new Error("Firebase service account key not found. Set FIREBASE_SERVICE_ACCOUNT_KEY env var or create firebase-service-account.json");
        }
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL // Your Firebase Realtime Database URL
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("ERROR: Failed to initialize Firebase Admin SDK:", error.message);
    process.exit(1);
}

const db = admin.database(); 


app.post('/sendRingingNotification', async (req, res) => {
  
    const { fcmTokens, callerId, callId, type, channel, token } = req.body;

    if (!fcmTokens || !Array.isArray(fcmTokens) || fcmTokens.length === 0) {
        return res.status(400).json({ error: 'fcmTokens (array) is required and must not be empty' });
    }
    if (!callerId || !callId || !type || !channel || !token) {
        return res.status(400).json({ error: 'callerId, callId, type, channel, and token are all required for a ringing notification.' });
    }

    const message = {
        data: {
            type: type, 
            callerId: callerId,
            callId: callId,
            channel: channel,
            token: token,
        },
        tokens: fcmTokens, 
        priority: 'high', 
        android: {
            priority: 'high'
        },
       
        content_available: true
       
    };

    try {
        const response = await admin.messaging().sendEachForMulticast(message);
        console.log('Successfully sent multicast ringing message:', response);
        const successfulSends = response.responses.filter(r => r.success).length;
        const failedSends = response.responses.filter(r => !r.success);

        if (failedSends.length > 0) {
            console.warn('Failed to send ringing to some tokens:', failedSends);
            
        }

        res.status(200).json({
            message: 'Ringing notifications sent successfully',
            successCount: successfulSends,
            failureCount: failedSends.length,
            details: response.responses
        });
    } catch (error) {
        console.error('Error sending multicast ringing message:', error);
        res.status(500).json({ error: 'Failed to send ringing notifications', details: error.message });
    }
});


app.post('/acceptCall', async (req, res) => {
    // Expected payload: { callId: "...", acceptedByDeviceId: "...", currentUid: "...", token: "...", channel: "..." }
    const { callId, acceptedByDeviceId, currentUid, token, channel } = req.body;

    if (!callId || !acceptedByDeviceId || !currentUid || !token || !channel) {
        return res.status(400).json({ error: 'callId, acceptedByDeviceId, currentUid, token, and channel are all required.' });
    }

    const activeCallRef = db.ref(`calls/${currentUid}/activeCall`);

    try {
        let transactionResult = await activeCallRef.transaction((currentData) => {
            // Case 1: No active call data, or the callId doesn't match
            if (!currentData || currentData.callId !== callId) {
                console.log(`Transaction aborted for callId ${callId}: Node missing or ID mismatch.`);
                return; // Abort transaction (return undefined)
            }

            // Case 2: Call is already in_progress or in an unexpected state
            if (currentData.status !== 'ringing') {
                console.log(`Transaction aborted for callId ${callId}: Call status is ${currentData.status}, not 'ringing'.`);
                return; // Abort transaction
            }

            // Case 3: Call is ringing and matches the callId - attempt to accept
            currentData.status = 'in_progress';
            currentData.acceptedByDeviceId = acceptedByDeviceId;
            console.log(`Call ${callId} accepted by ${acceptedByDeviceId}.`);
            return currentData; // Commit transaction with updated data
        });

        // Check if the transaction actually committed
        if (!transactionResult.committed) {
            // Transaction was aborted or failed
            if (transactionResult.snapshot.val() && transactionResult.snapshot.val().status === 'in_progress') {
                return res.status(409).json({ error: 'Call already accepted by another device.' });
            }
            return res.status(409).json({ error: 'Call no longer active or invalid call ID.' });
        }

       
        // Send 'ring_ended' notification to all OTHER secondary devices
        const devicesRef = db.ref(`calls/${currentUid}/devices`);
        const devicesSnapshot = await devicesRef.once('value');
        const allDevices = devicesSnapshot.val();

        if (allDevices) {
            const fcmTokensToNotify = [];
            for (const deviceIdKey in allDevices) {
                // Collect FCM tokens for devices OTHER THAN the one that accepted
                if (deviceIdKey !== acceptedByDeviceId && allDevices[deviceIdKey].fcmToken) {
                    fcmTokensToNotify.push(allDevices[deviceIdKey].fcmToken);
                }
            }

            if (fcmTokensToNotify.length > 0) {
                const ringEndedMessage = {
                    data: {
                        type: "ring_ended", // Signal to stop ringing
                        callId: callId,
                        acceptedByDeviceId: acceptedByDeviceId, // Inform which device accepted
                    },
                    tokens: fcmTokensToNotify,
                    priority: 'high', // Ensure this message also has high priority
                    android: {
                        priority: 'high'
                    },
                    content_available: true
                };
                try {
                    const fcmResponse = await admin.messaging().sendEachForMulticast(ringEndedMessage);
                    console.log('Successfully sent ring_ended multicast message:', fcmResponse);
                } catch (fcmError) {
                    console.error('Error sending ring_ended multicast message:', fcmError);
                }
            }
        }

        // Respond to the accepting secondary app with confirmation
        res.status(200).json({
            message: 'Call accepted successfully',
            callId: callId,
            token: token, // Return token and channel for the secondary app to join
            channel: channel,
            acceptedByDeviceId: acceptedByDeviceId
        });

    } catch (error) {
        console.error('Error during call acceptance process:', error);
        res.status(500).json({ error: 'Internal server error during call acceptance', details: error.message });
    }
});


// Basic health check endpoint
app.get('/', (req, res) => {
    res.send('Video Call Signaling Server V2 (No Agora Token Generation) is running!');
});

// Start the server
app.listen(port, () => {
    console.log(`Signaling server V2 listening on port ${port}`);
});
