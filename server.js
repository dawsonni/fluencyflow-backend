require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');

// Initialize Azure Key Vault client
const credential = new DefaultAzureCredential();
const keyVaultUrl = "https://fluencyflow-keyvault.vault.azure.net/";
const client = new SecretClient(keyVaultUrl, credential);

// Function to get secrets from Key Vault
async function getSecret(secretName) {
    try {
        const secret = await client.getSecret(secretName);
        return secret.value;
    } catch (error) {
        console.error(`Failed to get secret ${secretName}:`, error);
        // Fallback to environment variables
        return process.env[secretName.toUpperCase().replace(/-/g, '_')];
    }
}

// Helper function to get product ID for plan type
// Updated with live mode product IDs
function getProductId(planType) {
    const productMapping = {
        'starter': 'prod_TQKX3faDpap0ks',
        'professional': 'prod_TQKYZ1drtgQgxj', 
        'premium': 'prod_TQKYcpijkq1LcL'
    };
    return productMapping[planType] || 'prod_TQKX3faDpap0ks';
}


// Initialize Stripe with Key Vault
let stripe;
let stripeInitialized = false;

async function initializeStripe() {
    try {
        // Try live key first, fallback to test key for development
        let stripeSecretKey = await getSecret('stripe-secret-key-live');
        if (!stripeSecretKey || stripeSecretKey.includes('test')) {
            console.log('⚠️ Live key not found, trying test key...');
            stripeSecretKey = await getSecret('stripe-secret-key-test');
        }
        console.log('🔍 Retrieved Stripe key from Key Vault:', stripeSecretKey.substring(0, 20) + '...');
        stripe = require('stripe')(stripeSecretKey);
        stripeInitialized = true;
        const mode = stripeSecretKey.startsWith('sk_live_') ? 'LIVE' : 'TEST';
        console.log(`✅ Stripe initialized with Key Vault (${mode} mode)`);
    } catch (error) {
        console.error('❌ Failed to initialize Stripe:', error);
        stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        stripeInitialized = true;
    }
}

// Initialize Stripe
initializeStripe();

// Initialize Firebase Admin SDK
let firebaseInitialized = false;
async function initializeFirebase() {
    try {
        console.log('🔥 Starting Firebase initialization...');
        
        // Check if Firebase is already initialized
        if (admin.apps.length === 0) {
            console.log('🔥 No existing Firebase apps, initializing new one...');
            
            // Get Firebase service account key from Azure Key Vault
            console.log('🔥 Attempting to get Firebase service account from Azure Key Vault...');
            const firebaseServiceAccount = await getSecret('firebase-service-account');
            
            if (firebaseServiceAccount) {
                console.log('🔥 Firebase service account found in Key Vault, parsing JSON...');
                const serviceAccount = JSON.parse(firebaseServiceAccount);
                console.log('🔥 Service account project ID:', serviceAccount.project_id);
                
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                console.log('✅ Firebase Admin SDK initialized with Key Vault');
            } else {
                console.log('🔥 No Firebase service account in Key Vault, trying environment variable...');
                // Fallback to environment variable
                const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                console.log('✅ Firebase Admin SDK initialized with environment variable');
            }
        } else {
            console.log('🔥 Firebase already initialized, skipping...');
        }
        firebaseInitialized = true;
        console.log('✅ Firebase initialization completed successfully');
    } catch (error) {
        console.error('❌ Failed to initialize Firebase Admin SDK:', error);
        console.error('❌ Error details:', error.message);
        console.error('❌ Error stack:', error.stack);
        
        // Try to initialize with default credentials
        try {
            console.log('🔥 Trying to initialize with default credentials...');
            admin.initializeApp();
            firebaseInitialized = true;
            console.log('✅ Firebase Admin SDK initialized with default credentials');
        } catch (defaultError) {
            console.error('❌ Failed to initialize Firebase with default credentials:', defaultError);
            console.error('❌ Default error details:', defaultError.message);
        }
    }
}

// Initialize Firebase
initializeFirebase();

const app = express();
const PORT = process.env.PORT || 3000;

// Email configuration with Azure Key Vault
let emailTransporter;
(async () => {
    try {
        const gmailPassword = await getSecret('gmail-app-password');
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_USER || 'verification@fluencyflow.app',
                pass: gmailPassword
            }
        });
        console.log('✅ Email transporter initialized with Key Vault');
    } catch (error) {
        console.error('❌ Failed to initialize email transporter:', error);
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.GMAIL_USER || 'verification@fluencyflow.app',
                pass: process.env.GMAIL_APP_PASSWORD
            }
        });
    }
})();

// In-memory storage for verification tokens
// In production, you'd want to use a database like MongoDB or PostgreSQL
const verificationTokens = new Map();

// Middleware
app.use(cors());
// IMPORTANT: Do NOT apply JSON body parsing to the Stripe webhook route,
// Stripe requires the raw body for signature verification
app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe-webhook') {
        return next();
    }
    return express.json()(req, res, next);
});
app.use(express.static('public')); // Serve static files

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'FluencyFlow backend is running' });
});

// Test Azure Key Vault secrets endpoint
app.get('/api/test-secrets', async (req, res) => {
    try {
        const secrets = {};
        
        // Test Stripe keys
        try {
            secrets.stripeSecretKey = await getSecret('stripe-secret-key-test');
            secrets.stripePublishableKey = await getSecret('stripe-publishable-key-test');
        } catch (error) {
            secrets.stripeError = error.message;
        }
        
        // Test Azure keys
        try {
            secrets.azureSpeechKey = await getSecret('azure-speech-key');
            secrets.azureOpenAIKey = await getSecret('azure-openai-key');
        } catch (error) {
            secrets.azureError = error.message;
        }
        
        // Test Firebase key
        try {
            secrets.firebaseAPIKey = await getSecret('firebase-api-key');
        } catch (error) {
            secrets.firebaseError = error.message;
        }
        
        // Test Gmail password
        try {
            secrets.gmailPassword = await getSecret('gmail-app-password');
        } catch (error) {
            secrets.gmailError = error.message;
        }
        
        res.json({
            success: true,
            message: 'Azure Key Vault secrets test',
            secrets: {
                stripeSecretKey: secrets.stripeSecretKey ? `${secrets.stripeSecretKey.substring(0, 20)}...` : 'Not found',
                stripePublishableKey: secrets.stripePublishableKey ? `${secrets.stripePublishableKey.substring(0, 20)}...` : 'Not found',
                azureSpeechKey: secrets.azureSpeechKey ? `${secrets.azureSpeechKey.substring(0, 20)}...` : 'Not found',
                azureOpenAIKey: secrets.azureOpenAIKey ? `${secrets.azureOpenAIKey.substring(0, 20)}...` : 'Not found',
                firebaseAPIKey: secrets.firebaseAPIKey ? `${secrets.firebaseAPIKey.substring(0, 20)}...` : 'Not found',
                gmailPassword: secrets.gmailPassword ? `${secrets.gmailPassword.substring(0, 8)}...` : 'Not found'
            },
            errors: {
                stripeError: secrets.stripeError || null,
                azureError: secrets.azureError || null,
                firebaseError: secrets.firebaseError || null,
                gmailError: secrets.gmailError || null
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Serve verification page
app.get('/verify', (req, res) => {
    const token = req.query.token;
    
    if (!token) {
        return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Verification Error - FluencyFlow</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .error { color: #e74c3c; }
            </style>
        </head>
        <body>
            <h1 class="error">Verification Error</h1>
            <p>No verification token provided.</p>
        </body>
        </html>
        `);
    }
    
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Verify Parental Consent - FluencyFlow</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            
            .container {
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                padding: 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
            }
            
            .logo {
                color: #2563eb;
                font-size: 2rem;
                font-weight: bold;
                margin-bottom: 20px;
            }
            
            h1 {
                color: #1f2937;
                font-size: 1.5rem;
                margin-bottom: 20px;
                font-weight: 600;
            }
            
            .status {
                padding: 20px;
                border-radius: 12px;
                margin: 20px 0;
                font-weight: 500;
            }
            
            .loading {
                background: #fef3c7;
                color: #92400e;
                border: 1px solid #fcd34d;
            }
            
            .success {
                background: #d1fae5;
                color: #065f46;
                border: 1px solid #34d399;
            }
            
            .error {
                background: #fee2e2;
                color: #991b1b;
                border: 1px solid #f87171;
            }
            
            .info {
                background: #e0f2fe;
                color: #0c4a6e;
                border: 1px solid #7dd3fc;
            }
            
            .spinner {
                border: 3px solid #f3f3f3;
                border-top: 3px solid #2563eb;
                border-radius: 50%;
                width: 30px;
                height: 30px;
                animation: spin 1s linear infinite;
                margin: 0 auto 10px;
            }
            
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            
            .details {
                background: #f9fafb;
                border-radius: 8px;
                padding: 15px;
                margin: 20px 0;
                text-align: left;
                font-size: 0.9rem;
                color: #6b7280;
            }
            
            .button {
                background: #2563eb;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 8px;
                font-size: 1rem;
                font-weight: 500;
                cursor: pointer;
                text-decoration: none;
                display: inline-block;
                margin: 10px 5px;
                transition: background-color 0.2s;
            }
            
            .button:hover {
                background: #1d4ed8;
            }
            
            .button.secondary {
                background: #6b7280;
            }
            
            .button.secondary:hover {
                background: #4b5563;
            }
            
            .hidden {
                display: none;
            }
            
            .footer {
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #e5e7eb;
                font-size: 0.8rem;
                color: #9ca3af;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="logo">FluencyFlow</div>
            <h1>Verify Parental Consent</h1>
            
            <div id="loading" class="status loading">
                <div class="spinner"></div>
                <div>Verifying your consent...</div>
            </div>
            
            <div id="success" class="status success hidden">
                <div style="font-size: 2rem; margin-bottom: 10px;">✅</div>
                <div><strong>Verification Successful!</strong></div>
                <div id="successMessage"></div>
                <div class="details">
                    <div><strong>Child:</strong> <span id="childName"></span></div>
                    <div><strong>Parent Email:</strong> <span id="parentEmail"></span></div>
                    <div><strong>Verified:</strong> <span id="verifiedTime"></span></div>
                </div>
                <p style="margin-top: 15px; font-size: 0.9rem; color: #6b7280;">
                    You can now close this page and return to the FluencyFlow app to complete the account creation.
                </p>
            </div>
            
            <div id="error" class="status error hidden">
                <div style="font-size: 2rem; margin-bottom: 10px;">❌</div>
                <div><strong>Verification Failed</strong></div>
                <div id="errorMessage"></div>
                <div style="margin-top: 15px;">
                    <a href="#" onclick="window.close()" class="button secondary">Close</a>
                </div>
            </div>
            
            <div id="info" class="status info hidden">
                <div style="font-size: 2rem; margin-bottom: 10px;">ℹ️</div>
                <div><strong>Already Verified</strong></div>
                <div id="infoMessage"></div>
                <div class="details">
                    <div><strong>Child:</strong> <span id="infoChildName"></span></div>
                    <div><strong>Parent Email:</strong> <span id="infoParentEmail"></span></div>
                    <div><strong>Verified:</strong> <span id="infoVerifiedTime"></span></div>
                </div>
                <p style="margin-top: 15px; font-size: 0.9rem; color: #6b7280;">
                    This verification has already been completed. You can close this page and return to the FluencyFlow app.
                </p>
            </div>
            
            <div class="footer">
                <p>This verification is required by law to protect children's privacy online.</p>
                <p>If you have questions, contact us at <a href="mailto:support@fluencyflow.app" style="color: #2563eb;">support@fluencyflow.app</a></p>
            </div>
        </div>

        <script>
            async function verifyToken() {
                const token = '${token}';
                
                if (!token) {
                    showError('No verification token provided');
                    return;
                }
                
                try {
                    const response = await fetch('https://fluencyflow-backend-8e979bb2fc1f.herokuapp.com/api/verify-parental-consent', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ token: token })
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok && data.success) {
                        showSuccess(data);
                    } else {
                        if (data.error === 'This verification has already been completed') {
                            await showAlreadyVerified(token);
                        } else {
                            showError(data.error || 'Verification failed');
                        }
                    }
                    
                } catch (error) {
                    console.error('Verification error:', error);
                    showError('Network error. Please check your connection and try again.');
                }
            }
            
            async function showAlreadyVerified(token) {
                try {
                    const response = await fetch(\`https://fluencyflow-backend-8e979bb2fc1f.herokuapp.com/api/verification-status/\${token}\`);
                    const data = await response.json();
                    
                    if (response.ok && data.success) {
                        document.getElementById('loading').classList.add('hidden');
                        document.getElementById('info').classList.remove('hidden');
                        document.getElementById('infoChildName').textContent = data.childName;
                        document.getElementById('infoParentEmail').textContent = data.parentEmail;
                        document.getElementById('infoVerifiedTime').textContent = new Date(data.verifiedAt).toLocaleString();
                        document.getElementById('infoMessage').textContent = 'This verification has already been completed.';
                    } else {
                        showError('Unable to check verification status');
                    }
                } catch (error) {
                    showError('Unable to check verification status');
                }
            }
            
            function showSuccess(data) {
                document.getElementById('loading').classList.add('hidden');
                document.getElementById('success').classList.remove('hidden');
                document.getElementById('successMessage').textContent = data.message;
                document.getElementById('childName').textContent = data.childName;
                document.getElementById('parentEmail').textContent = data.parentEmail;
                document.getElementById('verifiedTime').textContent = new Date().toLocaleString();
            }
            
            function showError(message) {
                document.getElementById('loading').classList.add('hidden');
                document.getElementById('error').classList.remove('hidden');
                document.getElementById('errorMessage').textContent = message;
            }
            
            // Start verification when page loads
            window.addEventListener('load', verifyToken);
        </script>
    </body>
    </html>
    `);
});

// Send verification email endpoint
app.post('/api/send-verification-email', async (req, res) => {
    try {
        const { parentEmail, childName, verificationToken } = req.body;
        
        console.log('Sending verification email:', { parentEmail, childName, verificationToken });
        
        // Store verification token in memory (24 hour expiration)
        const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        verificationTokens.set(verificationToken, {
            parentEmail,
            childName,
            token: verificationToken,
            createdAt: Date.now(),
            expiresAt,
            isVerified: false
        });
        
        const verificationURL = `https://fluencyflow-backend-8e979bb2fc1f.herokuapp.com/verify?token=${verificationToken}`;
        
        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Verify Your Parental Consent - FluencyFlow</title>
        </head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #2563eb;">FluencyFlow</h1>
            </div>
            
            <h2>Verify Your Parental Consent</h2>
            
            <p>Hello,</p>
            
            <p>You are receiving this email because someone is trying to create a FluencyFlow account for your child, <strong>${childName}</strong>.</p>
            
            <p>To verify your parental consent and allow your child to use FluencyFlow, please click the verification link below:</p>
            
            <div style="text-align: center; margin: 30px 0;">
                <a href="${verificationURL}" style="background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Verify Parental Consent</a>
            </div>
            
            <p><strong>Important:</strong></p>
            <ul>
                <li>This verification link will expire in 24 hours</li>
                <li>Only click this link if you are the parent/guardian of ${childName}</li>
                <li>If you did not request this verification, please ignore this email</li>
            </ul>
            
            <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${verificationURL}</p>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
            
            <p style="font-size: 12px; color: #666;">
                This email was sent from FluencyFlow. If you have any questions, please contact us at support@fluencyflow.app
            </p>
        </body>
        </html>
        `;
        
        const textContent = `
        Verify Your Parental Consent - FluencyFlow
        
        Hello,
        
        You are receiving this email because someone is trying to create a FluencyFlow account for your child, ${childName}.
        
        To verify your parental consent and allow your child to use FluencyFlow, please visit this link:
        
        ${verificationURL}
        
        Important:
        - This verification link will expire in 24 hours
        - Only click this link if you are the parent/guardian of ${childName}
        - If you did not request this verification, please ignore this email
        
        If you have any questions, please contact us at support@fluencyflow.app
        
        FluencyFlow Team
        `;
        
        const mailOptions = {
            from: '"FluencyFlow Verification" <verification@fluencyflow.app>',
            to: parentEmail,
            subject: 'Verify Your Parental Consent - FluencyFlow',
            text: textContent,
            html: htmlContent
        };
        
        const info = await emailTransporter.sendMail(mailOptions);
        console.log('✅ Verification email sent:', info.messageId);
        
        res.json({ 
            success: true, 
            messageId: info.messageId,
            message: 'Verification email sent successfully' 
        });
        
    } catch (error) {
        console.error('❌ Error sending verification email:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Helper function to send subscription confirmation email with cancellation instructions
async function sendSubscriptionConfirmationEmail({ userEmail, planType, billingCycle, amount, nextBillingDate }) {
    const planDisplayName = planType.charAt(0).toUpperCase() + planType.slice(1);
    const billingDisplayName = billingCycle === 'monthly' ? 'Monthly' : 'Yearly';
    const renewalFrequency = billingCycle === 'monthly' ? 'month' : 'year';
    const formattedAmount = `$${amount.toFixed(2)}`;
    const formattedDate = new Date(nextBillingDate).toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Subscription Confirmation - FluencyFlow</title>
    </head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background-color: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #0ea5e9; margin: 0;">FluencyFlow</h1>
                <p style="color: #666; margin-top: 5px;">Speech Practice Made Easy</p>
            </div>
            
            <div style="background-color: #dbeafe; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                <h2 style="color: #0369a1; margin-top: 0;">✅ Subscription Confirmed!</h2>
                <p style="color: #075985; margin-bottom: 0;">Thank you for subscribing to FluencyFlow. Your subscription is now active.</p>
            </div>
            
            <h3 style="color: #333; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">Subscription Details</h3>
            <table style="width: 100%; margin-bottom: 30px;">
                <tr>
                    <td style="padding: 10px 0; color: #666;">Plan:</td>
                    <td style="padding: 10px 0; font-weight: bold; text-align: right;">${planDisplayName}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #666;">Billing:</td>
                    <td style="padding: 10px 0; font-weight: bold; text-align: right;">${billingDisplayName}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #666;">Amount:</td>
                    <td style="padding: 10px 0; font-weight: bold; text-align: right; color: #0ea5e9;">${formattedAmount}</td>
                </tr>
                <tr>
                    <td style="padding: 10px 0; color: #666;">Next Billing Date:</td>
                    <td style="padding: 10px 0; font-weight: bold; text-align: right;">${formattedDate}</td>
                </tr>
            </table>
            
            <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; border-left: 4px solid #f59e0b; margin-bottom: 30px;">
                <h3 style="color: #92400e; margin-top: 0;">⚠️ Auto-Renewal Notice</h3>
                <p style="color: #78350f; margin-bottom: 10px;">Your subscription will automatically renew every ${renewalFrequency} for ${formattedAmount} unless you cancel.</p>
                <p style="color: #78350f; margin-bottom: 0;"><strong>You can cancel anytime.</strong> Cancellation takes effect at the end of your billing period, so you'll keep access until ${formattedDate}.</p>
            </div>
            
            <h3 style="color: #333; border-bottom: 2px solid #0ea5e9; padding-bottom: 10px;">How to Cancel Your Subscription</h3>
            <div style="margin-bottom: 30px;">
                <div style="display: flex; margin-bottom: 15px;">
                    <div style="background-color: #0ea5e9; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 15px;">1</div>
                    <p style="margin: 5px 0; color: #333;">Open the FluencyFlow app and go to <strong>Settings</strong></p>
                </div>
                <div style="display: flex; margin-bottom: 15px;">
                    <div style="background-color: #0ea5e9; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 15px;">2</div>
                    <p style="margin: 5px 0; color: #333;">Tap <strong>Subscription</strong> and then <strong>Cancel Subscription</strong></p>
                </div>
                <div style="display: flex; margin-bottom: 15px;">
                    <div style="background-color: #0ea5e9; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 15px;">3</div>
                    <p style="margin: 5px 0; color: #333;">Or via iOS Settings: <strong>Settings → [Your Name] → Subscriptions → FluencyFlow</strong></p>
                </div>
            </div>
            
            <div style="background-color: #f0f9ff; padding: 15px; border-radius: 8px; margin-bottom: 30px;">
                <p style="margin: 0; font-size: 14px; color: #0369a1;">
                    <strong>Note:</strong> No refunds are provided for partial billing periods. You'll retain full access through the end of your current billing cycle after cancellation.
                </p>
            </div>
            
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
            
            <p style="font-size: 14px; color: #666; text-align: center;">
                Need help? Contact us at <a href="mailto:support@fluencyflow.app" style="color: #0ea5e9; text-decoration: none;">support@fluencyflow.app</a>
            </p>
            
            <p style="font-size: 12px; color: #999; text-align: center; margin-top: 20px;">
                This email confirms your FluencyFlow subscription. For billing questions, please contact support.
            </p>
        </div>
    </body>
    </html>
    `;
    
    const textContent = `
    Subscription Confirmation - FluencyFlow
    
    Thank you for subscribing to FluencyFlow!
    
    Subscription Details:
    - Plan: ${planDisplayName}
    - Billing: ${billingDisplayName}
    - Amount: ${formattedAmount}
    - Next Billing Date: ${formattedDate}
    
    AUTO-RENEWAL NOTICE:
    Your subscription will automatically renew every ${renewalFrequency} for ${formattedAmount} unless you cancel.
    You can cancel anytime. Cancellation takes effect at the end of your billing period.
    
    HOW TO CANCEL YOUR SUBSCRIPTION:
    
    1. Open the FluencyFlow app and go to Settings
    2. Tap "Subscription" and then "Cancel Subscription"
    3. Or via iOS Settings: Settings → [Your Name] → Subscriptions → FluencyFlow
    
    Note: No refunds are provided for partial billing periods. You'll retain full access through ${formattedDate} after cancellation.
    
    Need help? Contact us at support@fluencyflow.app
    
    FluencyFlow Team
    `;
    
    const mailOptions = {
        from: '"FluencyFlow" <subscriptions@fluencyflow.app>',
        to: userEmail,
        subject: `Subscription Confirmed - ${planDisplayName} Plan`,
        text: textContent,
        html: htmlContent
    };
    
    const info = await emailTransporter.sendMail(mailOptions);
    console.log('✅ Subscription confirmation email sent:', info.messageId);
    return info;
}

// Verify parental consent token endpoint
app.post('/api/verify-parental-consent', async (req, res) => {
    try {
        const { token } = req.body;
        
        console.log('Verifying parental consent token:', token);
        
        // Check if token exists in our verification storage
        // For now, we'll use a simple in-memory store
        // In production, you'd want to use a database
        if (!verificationTokens.has(token)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired verification token'
            });
        }
        
        const verificationData = verificationTokens.get(token);
        
        // Check if token is expired
        if (Date.now() > verificationData.expiresAt) {
            verificationTokens.delete(token);
            return res.status(400).json({
                success: false,
                error: 'Verification token has expired'
            });
        }
        
        // Check if already verified
        if (verificationData.isVerified) {
            return res.status(400).json({
                success: false,
                error: 'This verification has already been completed'
            });
        }
        
        // Mark as verified
        verificationData.isVerified = true;
        verificationData.verifiedAt = Date.now();
        verificationTokens.set(token, verificationData);
        
        console.log('✅ Parental consent verified for:', verificationData.childName);
        
        res.json({
            success: true,
            message: 'Parental consent verified successfully',
            childName: verificationData.childName,
            parentEmail: verificationData.parentEmail
        });
        
    } catch (error) {
        console.error('❌ Error verifying parental consent:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get verification status endpoint
app.get('/api/verification-status/:token', async (req, res) => {
    try {
        const { token } = req.params;
        
        console.log('Checking verification status for token:', token);
        
        if (!verificationTokens.has(token)) {
            return res.status(404).json({
                success: false,
                error: 'Verification token not found'
            });
        }
        
        const verificationData = verificationTokens.get(token);
        
        res.json({
            success: true,
            isVerified: verificationData.isVerified,
            childName: verificationData.childName,
            parentEmail: verificationData.parentEmail,
            expiresAt: verificationData.expiresAt,
            verifiedAt: verificationData.verifiedAt || null
        });
        
    } catch (error) {
        console.error('❌ Error checking verification status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current subscription endpoint
app.get('/api/current-subscription', async (req, res) => {
    try {
        // Wait for Firebase to be initialized
        while (!firebaseInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Get user ID from request headers or query params
        const userId = req.headers['user-id'] || req.query.userId;
        
        if (!userId) {
            console.log('No user ID provided - returning no subscription');
            return res.json(null); // No subscription for users without ID
        }
        
        console.log('Looking up subscription for user:', userId);
        console.log('User ID type:', typeof userId);
        console.log('User ID length:', userId ? userId.length : 'null');
        
        // First, try to find subscription in Firebase (faster and more reliable)
        console.log('🔥 Checking Firebase for subscription data first...');
        try {
            console.log('🔥 Firebase initialized status:', firebaseInitialized);
            console.log('🔥 Admin apps count:', admin.apps.length);
            
            const subscriptionQuery = await admin.firestore()
                .collection('subscriptions')
                .where('userId', '==', userId)
                .where('status', '==', 'active')
                .limit(1)
                .get();
            
            console.log('🔥 Firebase query completed, found', subscriptionQuery.docs.length, 'documents');
            
            if (!subscriptionQuery.empty) {
                const firebaseSub = subscriptionQuery.docs[0].data();
                console.log('✅ Found subscription in Firebase:', firebaseSub.id);
                console.log('✅ Subscription details:', {
                    planType: firebaseSub.planType,
                    status: firebaseSub.status,
                    userId: firebaseSub.userId
                });
                return res.json(firebaseSub);
            } else {
                console.log('🔥 No active subscription found in Firebase, checking Stripe...');
            }
        } catch (firebaseError) {
            console.error('❌ Firebase lookup failed:', firebaseError);
            console.error('❌ Firebase error details:', firebaseError.message);
            console.error('❌ Firebase error stack:', firebaseError.stack);
        }
        
        // Try to find customer in Stripe by email or metadata
        // For now, we'll check if there are any active subscriptions
        // In a real implementation, you'd store the Stripe customer ID with the user
        
        try {
            // Get user email from Firebase first (more reliable than metadata lookup)
            let userEmail = null;
            
            let customer = null;
            
            try {
                const userDoc = await admin.firestore().collection('users').doc(userId).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    userEmail = userData.email;
                    console.log('Found user email from Firebase:', userEmail);
                    console.log('User data keys:', Object.keys(userData));
                    
                    // Check if we have stored Stripe customer ID (most efficient)
                    if (userData.stripeCustomerId) {
                        console.log('Found stored Stripe customer ID:', userData.stripeCustomerId);
                        try {
                            customer = await stripe.customers.retrieve(userData.stripeCustomerId);
                            console.log('Retrieved customer by stored ID:', customer.id);
                        } catch (stripeError) {
                            console.log('Stored customer ID invalid, falling back to email lookup');
                            customer = null;
                        }
                    }
                } else {
                    console.log('User document not found in Firebase for userId:', userId);
                    return res.json(null);
                }
            } catch (firebaseError) {
                console.log('Failed to fetch user from Firebase:', firebaseError.message);
                return res.json(null);
            }
            
            // If no customer found by stored ID, try email lookup
            if (!customer && userEmail) {
                const customers = await stripe.customers.list({
                    email: userEmail,
                    limit: 1
                });
                
                if (customers.data.length > 0) {
                    customer = customers.data[0];
                    console.log('Found Stripe customer by email:', customer.id);
                }
            }
            
            if (!customer) {
                console.log('No Stripe customer found for user:', userId);
                return res.json(null); // No subscription
            }
            
            console.log('Found Stripe customer:', customer.id);
            
            // Get real Stripe subscriptions first
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1
            });
            
            if (subscriptions.data.length === 0) {
                console.log('No active subscriptions found for customer:', customer.id);
                
                // Fallback: Check Firebase for subscription data
                console.log('Checking Firebase for subscription data...');
                try {
                    const subscriptionQuery = await admin.firestore()
                        .collection('subscriptions')
                        .where('userId', '==', userId)
                        .where('status', '==', 'active')
                        .limit(1)
                        .get();
                    
                    if (!subscriptionQuery.empty) {
                        const firebaseSub = subscriptionQuery.docs[0].data();
                        console.log('Found subscription in Firebase:', firebaseSub.id);
                        return res.json(firebaseSub);
                    } else {
                        console.log('No subscription found in Firebase either');
                        return res.json(null);
                    }
                } catch (firebaseError) {
                    console.log('Firebase lookup failed:', firebaseError.message);
                    return res.json(null);
                }
            }
            
            const stripeSubscription = subscriptions.data[0];
            console.log('Found real Stripe subscription:', stripeSubscription.id);
            
            // Convert Stripe subscription to our format
            const subscription = {
                id: `sub_${stripeSubscription.id}`,
                userId: userId,
                stripeSubscriptionId: stripeSubscription.id,
                stripeCustomerId: customer.id,
                planType: stripeSubscription.metadata?.planType || "inactive",
                billingCycle: stripeSubscription.metadata?.billingCycle || "monthly",
                status: stripeSubscription.status,
                currentPeriodStart: stripeSubscription.current_period_start ? 
                    new Date(stripeSubscription.current_period_start * 1000).toISOString() : 
                    new Date().toISOString(),
                currentPeriodEnd: stripeSubscription.current_period_end ? 
                    new Date(stripeSubscription.current_period_end * 1000).toISOString() : 
                    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
                cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end || false,
                isTherapyReferral: stripeSubscription.metadata?.isTherapyReferral === 'true' || false,
                createdAt: stripeSubscription.created ? 
                    new Date(stripeSubscription.created * 1000).toISOString() : 
                    new Date().toISOString(),
                updatedAt: stripeSubscription.updated ? 
                    new Date(stripeSubscription.updated * 1000).toISOString() : 
                    new Date().toISOString()
            };
            
            console.log('Returning real subscription:', subscription.id);
            res.json(subscription);
            
        } catch (stripeError) {
            console.error('Stripe error:', stripeError);
            // If there's a Stripe error, return no subscription
            return res.json(null);
        }
        
    } catch (error) {
        console.error('Error fetching current subscription:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Customer portal endpoint
app.post('/api/customer-portal', async (req, res) => {
    try {
        const { user_id, user_email } = req.body;
        
        if (!user_id || !user_email) {
            return res.status(400).json({ 
                success: false, 
                error: 'User ID and email are required' 
            });
        }
        
        console.log('Creating customer portal session for user:', user_id);
        
        // First, find or create the Stripe customer
        let customer;
        try {
            // Try to find existing customer by email
            const customers = await stripe.customers.list({
                email: user_email,
                limit: 1
            });
            
            if (customers.data.length > 0) {
                customer = customers.data[0];
                console.log('Found existing customer:', customer.id);
            } else {
                // Create new customer
                customer = await stripe.customers.create({
                    email: user_email,
                    metadata: {
                        userId: user_id
                    }
                });
                console.log('Created new customer:', customer.id);
            }
        } catch (error) {
            console.error('Error finding/creating customer:', error);
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to find or create customer' 
            });
        }
        
        // Create customer portal session
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customer.id,
            return_url: 'https://fluencyflow-backend-8e979bb2fc1f.herokuapp.com/api/customer-portal-return'
        });
        
        console.log('Customer portal session created:', portalSession.id);
        res.json({ url: portalSession.url });
        
    } catch (error) {
        console.error('Error creating customer portal session:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Create setup intent endpoint for adding payment methods
app.post('/api/create-setup-intent', async (req, res) => {
    try {
        const { user_id, user_email } = req.body;
        
        if (!user_id || !user_email) {
            return res.status(400).json({ 
                success: false, 
                error: 'User ID and email are required' 
            });
        }
        
        console.log('Creating setup intent for user:', user_id);
        
        // First, find or create the Stripe customer
        let customer;
        try {
            // Try to find existing customer by email
            const customers = await stripe.customers.list({
                email: user_email,
                limit: 1
            });
            
            if (customers.data.length > 0) {
                customer = customers.data[0];
                console.log('Found existing customer:', customer.id);
            } else {
                // Create new customer
                customer = await stripe.customers.create({
                    email: user_email,
                    metadata: {
                        userId: user_id
                    }
                });
                console.log('Created new customer:', customer.id);
            }
        } catch (error) {
            console.error('Error finding/creating customer:', error);
            return res.status(500).json({ 
                success: false, 
                error: 'Failed to find or create customer' 
            });
        }
        
        // Create setup intent
        const setupIntent = await stripe.setupIntents.create({
            customer: customer.id,
            payment_method_types: ['card'],
            usage: 'off_session' // For future payments
        });
        
        console.log('Setup intent created:', setupIntent.id);
        res.json({ 
            success: true,
            client_secret: setupIntent.client_secret 
        });
        
    } catch (error) {
        console.error('Error creating setup intent:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Cancel subscription endpoint
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        let { subscription_id } = req.body;
        
        console.log('Cancelling subscription:', subscription_id);
        
        // Ensure we pass the full Stripe subscription ID (should start with 'sub_')
        if (!subscription_id || !subscription_id.startsWith('sub_')) {
            console.warn('⚠️ Expected a Stripe subscription ID starting with sub_. Received:', subscription_id);
        }
        
        // Cancel the subscription at the end of the current period
        let subscription;
        try {
            subscription = await stripe.subscriptions.update(subscription_id, {
                cancel_at_period_end: true
            });
            console.log('Subscription cancelled:', subscription.id);
        } catch (stripeError) {
            // Provide more helpful error message
            if (stripeError.type === 'StripeInvalidRequestError' && stripeError.code === 'resource_missing') {
                console.error(`❌ Subscription not found: ${subscription_id}`);
                console.error('⚠️ This might be a test mode subscription. Make sure you\'re using the correct Stripe mode.');
                throw new Error(`Subscription not found. This subscription may have been created in test mode, or it may have been deleted. Subscription ID: ${subscription_id}`);
            }
            throw stripeError;
        }
        
        // Update Firebase subscription status
        let updatedSubscriptionData = null;
        try {
            const subscriptionId = `sub_${subscription.id}`;
            await admin.firestore().collection('subscriptions').doc(subscriptionId).update({
                status: subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
                updatedAt: new Date().toISOString()
            });
            console.log('Updated Firebase subscription status to cancelled');
            
            // Fetch the complete subscription data from Firebase
            const subscriptionDoc = await admin.firestore().collection('subscriptions').doc(subscriptionId).get();
            if (subscriptionDoc.exists) {
                updatedSubscriptionData = subscriptionDoc.data();
            }
        } catch (firebaseError) {
            console.log('Failed to update Firebase subscription:', firebaseError.message);
            // Don't fail the cancellation if Firebase update fails
        }
        
        res.json({ 
            success: true, 
            subscription: updatedSubscriptionData || {
                id: `sub_${subscription.id}`,
                status: subscription.status,
                cancel_at_period_end: subscription.cancel_at_period_end,
                current_period_end: subscription.current_period_end,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString()
            }
        });
    } catch (error) {
        console.error('Error cancelling subscription:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Reactivate subscription endpoint
app.post('/api/reactivate-subscription', async (req, res) => {
    try {
        const { subscription_id } = req.body;
        
        console.log('Reactivating subscription:', subscription_id);
        
        // Reactivate the subscription by removing the cancel_at_period_end flag
        const subscription = await stripe.subscriptions.update(subscription_id, {
            cancel_at_period_end: false
        });
        
        console.log('Subscription reactivated:', subscription.id);
        
        // Update Firebase subscription status
        try {
            const subscriptionId = `sub_${subscription.id}`;
            await admin.firestore().collection('subscriptions').doc(subscriptionId).update({
                status: subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
                updatedAt: new Date().toISOString()
            });
            console.log('Updated Firebase subscription status to reactivated');
        } catch (firebaseError) {
            console.log('Failed to update Firebase subscription:', firebaseError.message);
            // Don't fail the reactivation if Firebase update fails
        }
        
        res.json({ 
            success: true, 
            subscription: {
                id: subscription.id,
                status: subscription.status,
                cancel_at_period_end: subscription.cancel_at_period_end,
                current_period_end: subscription.current_period_end
            }
        });
    } catch (error) {
        console.error('Error reactivating subscription:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Create payment intent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        // Wait for Stripe to be initialized
        while (!stripeInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const { amount, currency, plan_type, billing_cycle, is_therapy_referral, user_email, promo_code } = req.body;
        
        console.log('Creating payment intent:', { amount, currency, plan_type, billing_cycle, is_therapy_referral, user_email, promo_code });
        
        // Convert amount from cents to dollars for calculation
        const amountInDollars = amount / 100;
        let validatedAmount = amountInDollars;
        let couponId = null;
        
        // Calculate discount for display but don't apply to payment intent
        if (promo_code) {
            try {
                // Retrieve the promotion code from Stripe
                const promotionCodes = await stripe.promotionCodes.list({
                    code: promo_code,
                    active: true,
                    limit: 1
                });
                
                if (promotionCodes.data.length === 0) {
                    return res.status(400).json({ 
                        error: 'Invalid promo code',
                        details: 'Promo code not found or inactive'
                    });
                }
                
                const promotionCode = promotionCodes.data[0];
                couponId = promotionCode.coupon.id;
                
                // Calculate discount for display purposes
                if (promotionCode.coupon.percent_off) {
                    // Percentage discount
                    const discount = amountInDollars * (promotionCode.coupon.percent_off / 100);
                    validatedAmount = Math.max(0, amountInDollars - discount);
                } else if (promotionCode.coupon.amount_off) {
                    // Fixed amount discount
                    const discount = promotionCode.coupon.amount_off / 100; // Convert from cents
                    validatedAmount = Math.max(0, amountInDollars - discount);
                }
                
                console.log(`Stripe promo code ${promo_code} validated: coupon ${couponId}, display amount: ${validatedAmount}`);
                
            } catch (stripeError) {
                console.error('Error validating promo code with Stripe:', stripeError);
                return res.status(400).json({ 
                    error: 'Invalid promo code',
                    details: 'Failed to validate promo code'
                });
            }
        }
        
        // Create or find customer for this payment intent
        let customer;
        if (user_email) {
            try {
                // First, try to find existing customer
                const existingCustomers = await stripe.customers.list({
                    email: user_email,
                    limit: 1
                });
                
                if (existingCustomers.data.length > 0) {
                    customer = existingCustomers.data[0];
                    console.log('Found existing customer for payment intent:', customer.id);
                } else {
                    // Create new customer
                    customer = await stripe.customers.create({
                        email: user_email,
                        metadata: {
                            source: 'payment_intent_creation'
                        }
                    });
                    console.log('Created new customer for payment intent:', customer.id);
                }
            } catch (customerError) {
                console.error('Error with customer in payment intent:', customerError);
                // Continue without customer if there's an error
            }
        }
        
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount, // Use original amount in cents (no discount applied here)
            currency: currency,
            customer: customer?.id,
            setup_future_usage: 'off_session', // This will save the payment method for future use
            metadata: {
                plan_type,
                billing_cycle,
                is_therapy_referral: is_therapy_referral.toString(),
                promo_code: promo_code || '',
                original_amount: amountInDollars.toString(),
                coupon_id: couponId || ''
            }
        });
        
        res.json({
            id: paymentIntent.id,
            client_secret: paymentIntent.client_secret,
            amount: Math.round(validatedAmount * 100), // Return discounted amount in cents for display
            currency: paymentIntent.currency
        });
        
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create subscription endpoint
app.post('/api/create-subscription', async (req, res) => {
    try {
        // Wait for Stripe to be initialized
        while (!stripeInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Wait for Firebase to be initialized
        while (!firebaseInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const { plan_type, billing_cycle, is_therapy_referral, user_id, user_email, payment_intent_id, price_id, product_id, promo_code } = req.body;
        
        console.log('Creating subscription:', { plan_type, billing_cycle, is_therapy_referral, user_id, user_email, payment_intent_id });
        
        if (!user_id) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        // Create or find Stripe customer
        let customer;
        try {
            // First, try to find existing customer
            const existingCustomers = await stripe.customers.list({
                email: user_email,
                limit: 1
            });
            
            if (existingCustomers.data.length > 0) {
                customer = existingCustomers.data[0];
                console.log('Found existing customer:', customer.id);
                
                // Update customer metadata to ensure userId is set
                console.log('Customer metadata before update:', customer.metadata);
                if (!customer.metadata || !customer.metadata.userId) {
                    console.log('Updating customer metadata with userId:', user_id);
                    const updatedCustomer = await stripe.customers.update(customer.id, {
                        metadata: {
                            ...customer.metadata,
                            userId: user_id,
                            plan_type: plan_type,
                            is_therapy_referral: is_therapy_referral.toString()
                        }
                    });
                    console.log('Customer metadata after update:', updatedCustomer.metadata);
                } else {
                    console.log('Customer already has userId in metadata:', customer.metadata.userId);
                }
            } else {
                // Create new customer
                customer = await stripe.customers.create({
                    email: user_email,
                    metadata: {
                        userId: user_id,
                        plan_type: plan_type,
                        is_therapy_referral: is_therapy_referral.toString()
                    }
                });
                console.log('Created new customer:', customer.id);
            }
        } catch (customerError) {
            console.error('Error with customer:', customerError);
            return res.status(500).json({ error: 'Failed to create/find customer' });
        }
        
        // Cancel any existing active subscriptions for this user before creating a new one
        try {
            console.log('Checking for existing active subscriptions for user:', user_id);
            
            // Find existing active subscriptions in Firebase
            const existingSubscriptions = await admin.firestore()
                .collection('subscriptions')
                .where('userId', '==', user_id)
                .where('status', '==', 'active')
                .get();
            
            if (!existingSubscriptions.empty) {
                console.log(`Found ${existingSubscriptions.docs.length} existing active subscriptions, canceling them...`);
                
                // Cancel each existing subscription in Stripe and update Firebase
                for (const doc of existingSubscriptions.docs) {
                    const existingSub = doc.data();
                    console.log(`Canceling existing subscription: ${existingSub.stripeSubscriptionId}`);
                    
                    try {
                        // Cancel in Stripe
                        await stripe.subscriptions.update(existingSub.stripeSubscriptionId, {
                            cancel_at_period_end: true
                        });
                        
                        // Update in Firebase
                        await doc.ref.update({
                            status: 'canceled',
                            cancelAtPeriodEnd: true,
                            updatedAt: new Date().toISOString()
                        });
                        
                        console.log(`✅ Canceled subscription: ${existingSub.stripeSubscriptionId}`);
                    } catch (cancelError) {
                        console.error(`❌ Failed to cancel subscription ${existingSub.stripeSubscriptionId}:`, cancelError);
                        // Continue with new subscription creation even if cancellation fails
                    }
                }
            } else {
                console.log('No existing active subscriptions found');
            }
        } catch (existingSubError) {
            console.error('Error handling existing subscriptions:', existingSubError);
            // Continue with new subscription creation even if existing subscription handling fails
        }
        
        // Create subscription in Stripe
        try {
            // Use the price_id from the request body (sent from iOS app)
            let priceId = price_id;
            
            // Fallback to hardcoded mapping if price_id not provided (for backward compatibility)
            // Updated with live mode price IDs
            if (!priceId) {
                if (plan_type === 'starter' && billing_cycle === 'monthly') {
                    priceId = 'price_1STTsfCdYlZtgYGH84EG1xr3';
                } else if (plan_type === 'starter' && billing_cycle === 'yearly') {
                    priceId = 'price_1STTsfCdYlZtgYGHTI2MDIOF';
                } else if (plan_type === 'professional' && billing_cycle === 'monthly') {
                    priceId = 'price_1STTtDCdYlZtgYGHzir9N25f';
                } else if (plan_type === 'professional' && billing_cycle === 'yearly') {
                    priceId = 'price_1STTtDCdYlZtgYGHzFQDaZ0L';
                } else if (plan_type === 'premium' && billing_cycle === 'monthly') {
                    priceId = 'price_1STTtGCdYlZtgYGHtVqFhO2M';
                } else if (plan_type === 'premium' && billing_cycle === 'yearly') {
                    priceId = 'price_1STTtGCdYlZtgYGHCIrEGABA';
                } else {
                    throw new Error(`Unsupported plan: ${plan_type} ${billing_cycle}`);
                }
            }
            
            console.log(`Creating Stripe subscription with price ID: ${priceId}`);
            
            // If we have a payment intent ID, retrieve the payment method and attach it to the customer
            if (payment_intent_id) {
                console.log('Attempting to attach payment method from payment intent:', payment_intent_id);
                try {
                    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
                    console.log('Retrieved payment intent:', paymentIntent.id, 'Status:', paymentIntent.status);
                    console.log('Payment method ID:', paymentIntent.payment_method);
                    
                    if (paymentIntent.payment_method) {
                        // Attach the payment method to the customer
                        console.log('Attaching payment method to customer:', customer.id);
                        await stripe.paymentMethods.attach(paymentIntent.payment_method, {
                            customer: customer.id,
                        });
                        
                        // Set as default payment method
                        console.log('Setting as default payment method');
                        await stripe.customers.update(customer.id, {
                            invoice_settings: {
                                default_payment_method: paymentIntent.payment_method,
                            },
                        });
                        
                        console.log('Payment method attached successfully:', paymentIntent.payment_method);
                    } else {
                        console.log('No payment method found in payment intent');
                    }
                } catch (pmError) {
                    console.error('Error attaching payment method:', pmError);
                    console.error('Payment method error details:', pmError.message);
                    // Continue with subscription creation even if payment method attachment fails
                }
            } else {
                console.log('No payment intent ID provided');
            }
            
            // Verify customer has a payment method before creating subscription
            const customerWithPaymentMethods = await stripe.customers.retrieve(customer.id, {
                expand: ['invoice_settings.default_payment_method']
            });
            
            console.log('Customer payment method status:', {
                hasDefaultPaymentMethod: !!customerWithPaymentMethods.invoice_settings?.default_payment_method,
                defaultPaymentMethodId: customerWithPaymentMethods.invoice_settings?.default_payment_method?.id
            });
            
            const subscriptionData = {
                customer: customer.id,
                items: [{
                    price: priceId,
                }],
                metadata: {
                    userId: user_id,
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    isTherapyReferral: is_therapy_referral.toString(),
                    promo_code: promo_code || ''
                }
            };
            
            // Add coupon if promo code was provided
            if (promo_code) {
                try {
                    // Get the promotion code to find the coupon
                    const promotionCodes = await stripe.promotionCodes.list({
                        code: promo_code,
                        active: true,
                        limit: 1
                    });
                    
                    if (promotionCodes.data.length > 0) {
                        subscriptionData.coupon = promotionCodes.data[0].coupon.id;
                        console.log(`Applying coupon ${subscriptionData.coupon} to subscription`);
                    }
                } catch (couponError) {
                    console.error('Error applying coupon to subscription:', couponError);
                    // Continue without coupon if there's an error
                }
            }
            
            const stripeSubscription = await stripe.subscriptions.create(subscriptionData);
            
            console.log('Stripe subscription created successfully:', stripeSubscription.id);
            console.log('Subscription status:', stripeSubscription.status);
            
            // Store Stripe customer ID in Firebase user document for future lookups
            try {
                await admin.firestore().collection('users').doc(user_id).update({
                    stripeCustomerId: customer.id,
                    lastUpdated: new Date().toISOString()
                });
                console.log('Updated Firebase user with Stripe customer ID:', customer.id);
            } catch (firebaseUpdateError) {
                console.log('Failed to update Firebase user with Stripe customer ID:', firebaseUpdateError.message);
                // Don't fail the subscription creation if Firebase update fails
            }
            
            console.log('Created real Stripe subscription:', stripeSubscription.id);
            
            // Convert Stripe subscription to our format
            const subscription = {
                id: `sub_${stripeSubscription.id}`,
                userId: user_id,
                stripeSubscriptionId: stripeSubscription.id,
                stripeCustomerId: customer.id,
                planType: plan_type,
                billingCycle: billing_cycle,
                status: stripeSubscription.status,
                currentPeriodStart: stripeSubscription.current_period_start ? 
                    new Date(stripeSubscription.current_period_start * 1000).toISOString() : 
                    new Date().toISOString(),
                currentPeriodEnd: stripeSubscription.current_period_end ? 
                    new Date(stripeSubscription.current_period_end * 1000).toISOString() : 
                    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
                cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end || false,
                isTherapyReferral: is_therapy_referral,
                createdAt: stripeSubscription.created ? 
                    new Date(stripeSubscription.created * 1000).toISOString() : 
                    new Date().toISOString(),
                updatedAt: stripeSubscription.updated ? 
                    new Date(stripeSubscription.updated * 1000).toISOString() : 
                    new Date().toISOString()
            };
            
            // Save subscription to Firebase
            try {
                const subscriptionId = `sub_${stripeSubscription.id}`;
                await admin.firestore().collection('subscriptions').doc(subscriptionId).set({
                    id: subscriptionId,
                    userId: user_id,
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    status: stripeSubscription.status,
                    stripeSubscriptionId: stripeSubscription.id,
                    stripeCustomerId: customer.id,
                    currentPeriodStart: subscription.currentPeriodStart,
                    currentPeriodEnd: subscription.currentPeriodEnd,
                    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                    isTherapyReferral: is_therapy_referral,
                    createdAt: subscription.createdAt,
                    updatedAt: subscription.updatedAt
                });
                console.log('✅ Subscription saved to Firebase:', subscriptionId);
                
                // Create financial record for tax compliance
                try {
                    // Get amount from Stripe subscription
                    const amount = stripeSubscription.items.data[0]?.price?.unit_amount / 100 || 0; // Convert cents to dollars
                    
                    await createFinancialRecord({
                        userId: user_id,
                        userEmail: user_email,
                        userName: null, // We don't have user name in this endpoint
                        stripeSubscriptionId: stripeSubscription.id,
                        stripeCustomerId: customer.id,
                        planType: plan_type,
                        billingCycle: billing_cycle,
                        amount: amount,
                        startDate: subscription.currentPeriodStart,
                        endDate: subscription.currentPeriodEnd,
                        status: stripeSubscription.status,
                        isTherapyReferral: is_therapy_referral,
                        promoCode: promo_code || null
                    });
                } catch (financialError) {
                    console.error('❌ Failed to create financial record:', financialError);
                    // Continue even if financial record fails
                }
            } catch (firebaseError) {
                console.error('❌ Failed to save subscription to Firebase:', firebaseError);
                // Don't fail the subscription creation if Firebase save fails
            }
            
            // Send subscription confirmation email with cancellation instructions
            try {
                await sendSubscriptionConfirmationEmail({
                    userEmail: user_email,
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    amount: stripeSubscription.items.data[0]?.price?.unit_amount / 100 || 0,
                    nextBillingDate: subscription.currentPeriodEnd
                });
                console.log('✅ Subscription confirmation email sent');
            } catch (emailError) {
                console.error('❌ Failed to send subscription confirmation email:', emailError);
                // Continue even if email fails - don't block subscription creation
            }
            
            res.json(subscription);
            
        } catch (subscriptionError) {
            console.error('Error creating subscription:', subscriptionError);
            console.error('Subscription error details:', subscriptionError.message);
            if (subscriptionError.response) {
                console.error('Stripe API error response:', subscriptionError.response.data);
            }
            return res.status(500).json({ 
                error: 'Failed to create subscription',
                details: subscriptionError.message 
            });
        }
        
    } catch (error) {
        console.error('Error creating subscription:', error);
        res.status(500).json({ error: error.message });
    }
});

// Modify subscription endpoint (for upgrades/downgrades)
app.post('/api/modify-subscription', async (req, res) => {
    try {
        // Wait for Stripe to be initialized
        while (!stripeInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Wait for Firebase to be initialized
        while (!firebaseInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const { plan_type, billing_cycle, user_id, user_email, price_id, product_id, promo_code } = req.body;
        
        console.log('Modifying subscription:', { plan_type, billing_cycle, user_id, user_email, price_id });
        
        if (!user_id) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        // Find existing customer
        let customer;
        try {
            const existingCustomers = await stripe.customers.list({
                email: user_email,
                limit: 1
            });
            
            if (existingCustomers.data.length === 0) {
                return res.status(404).json({ error: 'Customer not found' });
            }
            
            customer = existingCustomers.data[0];
            console.log('Found existing customer:', customer.id);
        } catch (customerError) {
            console.error('Error finding customer:', customerError);
            return res.status(500).json({ error: 'Failed to find customer' });
        }
        
        // Find existing active subscription
        let existingSubscription;
        try {
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1
            });
            
            if (subscriptions.data.length === 0) {
                return res.status(404).json({ error: 'No active subscription found' });
            }
            
            existingSubscription = subscriptions.data[0];
            console.log('Found existing subscription:', existingSubscription.id);
        } catch (subError) {
            console.error('Error finding subscription:', subError);
            return res.status(500).json({ error: 'Failed to find existing subscription' });
        }
        
        // Get the new price ID
        let newPriceId = price_id;
        if (!newPriceId) {
            // Fallback to hardcoded mapping
            if (plan_type === 'starter' && billing_cycle === 'monthly') {
                newPriceId = 'price_1SBMCh2QVCQwj6xKAxuwKisC';
            } else if (plan_type === 'starter' && billing_cycle === 'yearly') {
                newPriceId = 'price_1SBMGX2QVCQwj6xKb9suTwhR';
            } else if (plan_type === 'professional' && billing_cycle === 'monthly') {
                newPriceId = 'price_1SBMHE2QVCQwj6xKgYNPRtB6';
            } else if (plan_type === 'professional' && billing_cycle === 'yearly') {
                newPriceId = 'price_1SBMHU2QVCQwj6xKk4AtbNBd';
            } else if (plan_type === 'premium' && billing_cycle === 'monthly') {
                newPriceId = 'price_1SBMHv2QVCQwj6xKON7BWqbX';
            } else if (plan_type === 'premium' && billing_cycle === 'yearly') {
                newPriceId = 'price_1SBMI52QVCQwj6xKlJR975L0';
            } else {
                throw new Error(`Unsupported plan: ${plan_type} ${billing_cycle}`);
            }
        }
        
        console.log(`Modifying subscription to price ID: ${newPriceId}`);
        
        // Update the subscription with the new plan
        try {
            const updateData = {
                items: [{
                    id: existingSubscription.items.data[0].id,
                    price: newPriceId,
                }],
                proration_behavior: 'create_prorations', // This handles proration automatically
                metadata: {
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    productId: product_id || getProductId(plan_type),
                    isTherapyReferral: 'false',
                    modifiedAt: new Date().toISOString(),
                    promoCode: promo_code || ''
                }
            };
            
            // Add coupon if promo code was provided
            if (promo_code) {
                try {
                    // Get the promotion code to find the coupon
                    const promotionCodes = await stripe.promotionCodes.list({
                        code: promo_code,
                        active: true,
                        limit: 1
                    });
                    
                    if (promotionCodes.data.length > 0) {
                        updateData.coupon = promotionCodes.data[0].coupon.id;
                        console.log(`Applying coupon ${updateData.coupon} to subscription modification`);
                    }
                } catch (couponError) {
                    console.error('Error applying coupon to subscription modification:', couponError);
                    // Continue without coupon if there's an error
                }
            }
            
            console.log('📋 Sending update to Stripe with metadata:', JSON.stringify(updateData.metadata));
            
            const updatedSubscription = await stripe.subscriptions.update(existingSubscription.id, updateData);
            
            console.log('Subscription updated successfully:', updatedSubscription.id);
            console.log('📋 Stripe returned metadata:', JSON.stringify(updatedSubscription.metadata));
            
            // Update customer metadata
            await stripe.customers.update(customer.id, {
                metadata: {
                    ...customer.metadata,
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    lastModified: new Date().toISOString()
                }
            });
            
            // IMPORTANT: Directly update Firebase since webhook may not fire reliably
            try {
                const subscriptionId = `sub_${updatedSubscription.id}`;
                await admin.firestore().collection('subscriptions').doc(subscriptionId).update({
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    status: updatedSubscription.status,
                    currentPeriodStart: new Date(updatedSubscription.current_period_start * 1000).toISOString(),
                    currentPeriodEnd: new Date(updatedSubscription.current_period_end * 1000).toISOString(),
                    cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end || false,
                    updatedAt: new Date().toISOString()
                });
                console.log('✅ Firebase updated directly with new plan type:', plan_type);
            } catch (firebaseError) {
                console.error('❌ Failed to update Firebase directly:', firebaseError);
                // Don't fail the request if Firebase update fails
            }
            
            console.log('✅ Subscription modified successfully:', updatedSubscription.id);
            
            res.json({
                success: true,
                subscription: {
                    id: updatedSubscription.id,
                    status: updatedSubscription.status,
                    plan_type: plan_type,
                    billing_cycle: billing_cycle,
                    current_period_start: updatedSubscription.current_period_start,
                    current_period_end: updatedSubscription.current_period_end,
                    proration_behavior: 'create_prorations'
                }
            });
            
        } catch (updateError) {
            console.error('Error updating subscription:', updateError);
            res.status(500).json({ 
                error: 'Failed to update subscription',
                details: updateError.message 
            });
        }
        
    } catch (error) {
        console.error('Error modifying subscription:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stripe Webhook Handler
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    // Try to get webhook secret from Key Vault (live first, then test), fallback to env var
    let endpointSecret;
    try {
        endpointSecret = await getSecret('stripe-webhook-secret-live');
        if (!endpointSecret) {
            endpointSecret = await getSecret('stripe-webhook-secret-test');
        }
    } catch (error) {
        endpointSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET;
    }

    let event;

    // If no webhook secret is configured, handle accordingly
    if (!endpointSecret) {
        console.warn('⚠️ WARNING: No webhook secret configured. Webhook verification skipped.');
        console.warn('⚠️ Webhooks are optional but recommended for production.');
        console.warn('⚠️ Without webhooks, you\'ll need to manually sync Stripe and Firebase.');
        console.warn('⚠️ Add webhook secret to Azure Key Vault or environment variables if you want automatic sync.');
        
        // Allow webhooks to work without verification (less secure but allows operation without webhook setup)
        // Note: This means webhooks won't be verified, but they'll still work
        try {
            event = JSON.parse(req.body.toString());
            console.log(`📡 Received webhook (unverified): ${event.type}`);
        } catch (parseError) {
            console.error('❌ Failed to parse webhook event:', parseError.message);
            return res.status(400).send('Invalid webhook payload');
        }
    } else {
        // Verify webhook signature when secret is available
        try {
            event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
            console.log(`📡 Received webhook: ${event.type}`);
        } catch (err) {
            console.log(`❌ Webhook signature verification failed:`, err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    }

    try {
        switch (event.type) {
            case 'customer.subscription.created':
                await handleSubscriptionCreated(event.data.object);
                break;
            
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;
            
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;
            
            case 'customer.deleted':
                await handleCustomerDeleted(event.data.object);
                break;
            
            case 'invoice.payment_succeeded':
                await handleInvoicePaymentSucceeded(event.data.object);
                break;
            
            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(event.data.object);
                break;
            
            default:
                console.log(`ℹ️ Unhandled event type: ${event.type}`);
        }
        
        res.json({received: true});
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.status(500).json({error: 'Webhook handler failed'});
    }
});

// MARK: - Financial Records for Tax Compliance

/**
 * Create a financial record for tax compliance
 * This record is kept for 7 years even if user deletes their account (anonymized)
 */
async function createFinancialRecord(subscriptionData) {
    try {
        const recordId = `fin_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const lastTransactionDate = new Date();
        const retainUntil = new Date(lastTransactionDate);
        retainUntil.setFullYear(retainUntil.getFullYear() + 7); // 7 years from now
        
        const financialRecord = {
            recordId: recordId,
            userId: subscriptionData.userId,
            userEmail: subscriptionData.userEmail || null,
            userName: subscriptionData.userName || null,
            
            // Subscription/Revenue Data
            subscriptionId: subscriptionData.stripeSubscriptionId,
            stripeCustomerId: subscriptionData.stripeCustomerId || null,
            planType: subscriptionData.planType,
            billingCycle: subscriptionData.billingCycle,
            amount: subscriptionData.amount || 0,
            currency: 'usd',
            startDate: subscriptionData.startDate,
            endDate: subscriptionData.endDate,
            lastTransactionDate: lastTransactionDate.toISOString(),
            
            // Status
            status: subscriptionData.status || 'active',
            isTherapyReferral: subscriptionData.isTherapyReferral || false,
            promoCode: subscriptionData.promoCode || null,
            
            // Deletion Tracking
            isAnonymized: false,
            anonymizedAt: null,
            retainUntil: retainUntil.toISOString(),
            
            // Audit Trail
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        await admin.firestore().collection('financial_records').doc(recordId).set(financialRecord);
        console.log('✅ Financial record created:', recordId);
        
        return recordId;
    } catch (error) {
        console.error('❌ Error creating financial record:', error);
        // Don't fail subscription creation if financial record fails
        return null;
    }
}

/**
 * Anonymize financial records when user deletes account
 * Keeps revenue data for tax compliance but removes PII
 */
async function anonymizeFinancialRecords(userId) {
    try {
        console.log('🔒 Anonymizing financial records for user:', userId);
        
        const financialRecords = await admin.firestore()
            .collection('financial_records')
            .where('userId', '==', userId)
            .where('isAnonymized', '==', false)
            .get();
        
        if (financialRecords.empty) {
            console.log('ℹ️ No financial records to anonymize');
            return;
        }
        
        const batch = admin.firestore().batch();
        for (const doc of financialRecords.docs) {
            batch.update(doc.ref, {
                userId: '[DELETED]',
                userEmail: '[DELETED]',
                userName: '[DELETED]',
                stripeCustomerId: '[DELETED]',  // Don't need this after deletion
                isAnonymized: true,
                anonymizedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
        }
        
        await batch.commit();
        console.log(`✅ Anonymized ${financialRecords.docs.length} financial records`);
        
    } catch (error) {
        console.error('❌ Error anonymizing financial records:', error);
        throw error;
    }
}

/**
 * Clean up expired financial records (7+ years old)
 * Should be run periodically (monthly cron job)
 */
async function cleanupExpiredFinancialRecords() {
    try {
        console.log('🧹 Cleaning up expired financial records...');
        
        const now = new Date();
        const expiredRecords = await admin.firestore()
            .collection('financial_records')
            .where('retainUntil', '<', now.toISOString())
            .get();
        
        if (expiredRecords.empty) {
            console.log('ℹ️ No expired financial records to clean up');
            return { deleted: 0 };
        }
        
        const batch = admin.firestore().batch();
        for (const doc of expiredRecords.docs) {
            batch.delete(doc.ref);
        }
        
        await batch.commit();
        console.log(`✅ Deleted ${expiredRecords.docs.length} expired financial records`);
        
        return { deleted: expiredRecords.docs.length };
        
    } catch (error) {
        console.error('❌ Error cleaning up expired financial records:', error);
        throw error;
    }
}

// Webhook Event Handlers
async function handleSubscriptionCreated(subscription) {
    console.log('📋 Subscription created:', subscription.id);
    
    try {
        // Get customer email
        const customer = await stripe.customers.retrieve(subscription.customer);
        
        // Find userId
        const userQuery = await admin.firestore().collection('users')
            .where('email', '==', customer.email)
            .limit(1)
            .get();
        
        if (userQuery.empty) {
            console.log('⚠️ No user found for customer:', customer.email);
            return;
        }
        
        const userId = userQuery.docs[0].id;
        
        // Create subscription in Firebase
        const subscriptionData = {
            id: `sub_${subscription.id}`,
            userId: userId,
            planType: subscription.metadata?.planType || 'unknown',
            billingCycle: subscription.metadata?.billingCycle || 'monthly',
            status: subscription.status,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: subscription.customer,
            currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
            isTherapyReferral: subscription.metadata?.isTherapyReferral === 'true' || false,
            createdAt: new Date(subscription.created * 1000).toISOString(),
            updatedAt: new Date(subscription.updated * 1000).toISOString()
        };
        
        await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).set(subscriptionData);
        console.log('✅ Subscription created in Firebase');
        
        // Create financial record for tax compliance
        try {
            const customer = await stripe.customers.retrieve(subscription.customer);
            const amount = subscription.items.data[0]?.price?.unit_amount / 100 || 0;
            
            await createFinancialRecord({
                userId: userId,
                userEmail: customer.email,
                userName: null,
                stripeSubscriptionId: subscription.id,
                stripeCustomerId: subscription.customer,
                planType: subscription.metadata?.planType || 'unknown',
                billingCycle: subscription.metadata?.billingCycle || 'monthly',
                amount: amount,
                startDate: new Date(subscription.current_period_start * 1000).toISOString(),
                endDate: new Date(subscription.current_period_end * 1000).toISOString(),
                status: subscription.status,
                isTherapyReferral: subscription.metadata?.isTherapyReferral === 'true' || false,
                promoCode: subscription.metadata?.promo_code || null
            });
            console.log('✅ Financial record created from webhook');
        } catch (financialError) {
            console.error('❌ Failed to create financial record from webhook:', financialError);
        }
    } catch (error) {
        console.error('❌ Error handling subscription created:', error);
    }
}

async function handleSubscriptionUpdated(subscription) {
    console.log('📋 Subscription updated:', subscription.id);
    
    try {
        // Log the raw metadata to see what Stripe is sending
        console.log('📋 Stripe metadata received:', JSON.stringify(subscription.metadata));
        
        // Update subscription in Firebase - ALWAYS include planType and billingCycle from metadata
        const subscriptionData = {
            status: subscription.status,
            planType: subscription.metadata?.planType || 'unknown',
            billingCycle: subscription.metadata?.billingCycle || 'monthly',
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
            currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            updatedAt: new Date(subscription.updated * 1000).toISOString()
        };
        
        // Add canceledAt timestamp if subscription is being canceled
        if (subscription.status === 'canceled') {
            subscriptionData.canceledAt = new Date().toISOString();
        }
        
        console.log(`📋 Updating subscription with planType: ${subscriptionData.planType}, billingCycle: ${subscriptionData.billingCycle}`);
        
        await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).update(subscriptionData);
        console.log('✅ Subscription updated in Firebase');
        
        // If this subscription became active, ensure no other active subscriptions for this user
        if (subscription.status === 'active') {
            await ensureSingleActiveSubscription(subscription);
        }
        
        // Log status change for monitoring
        if (subscription.status === 'canceled') {
            console.log('🚨 Subscription canceled:', subscription.id);
        } else if (subscription.status === 'active' && subscription.cancel_at_period_end) {
            console.log('⚠️ Subscription set to cancel at period end:', subscription.id);
        }
    } catch (error) {
        console.error('❌ Error handling subscription updated:', error);
    }
}

// Helper function to ensure only one active subscription per user
async function ensureSingleActiveSubscription(activeSubscription) {
    try {
        // Get customer email to find userId
        const customer = await stripe.customers.retrieve(activeSubscription.customer);
        
        // Find userId from customer email
        const userQuery = await admin.firestore().collection('users')
            .where('email', '==', customer.email)
            .limit(1)
            .get();
        
        if (userQuery.empty) {
            console.log('⚠️ No user found for customer:', customer.email);
            return;
        }
        
        const userId = userQuery.docs[0].id;
        
        // Find all other active subscriptions for this user
        const otherActiveSubscriptions = await admin.firestore()
            .collection('subscriptions')
            .where('userId', '==', userId)
            .where('status', '==', 'active')
            .where('stripeSubscriptionId', '!=', activeSubscription.id)
            .get();
        
        if (!otherActiveSubscriptions.empty) {
            console.log(`🔄 Found ${otherActiveSubscriptions.docs.length} other active subscriptions for user ${userId}, canceling them...`);
            
            // Cancel other active subscriptions
            for (const doc of otherActiveSubscriptions.docs) {
                const subData = doc.data();
                console.log(`   Canceling duplicate subscription: ${subData.stripeSubscriptionId}`);
                
                try {
                    // Cancel in Stripe
                    await stripe.subscriptions.update(subData.stripeSubscriptionId, {
                        cancel_at_period_end: true
                    });
                    
                    // Update in Firebase
                    await doc.ref.update({
                        status: 'canceled',
                        cancelAtPeriodEnd: true,
                        updatedAt: new Date().toISOString()
                    });
                    
                    console.log(`   ✅ Canceled duplicate: ${subData.stripeSubscriptionId}`);
                } catch (cancelError) {
                    console.error(`   ❌ Failed to cancel duplicate ${subData.stripeSubscriptionId}:`, cancelError);
                }
            }
        }
    } catch (error) {
        console.error('❌ Error ensuring single active subscription:', error);
    }
}

async function handleSubscriptionDeleted(subscription) {
    console.log('📋 Subscription deleted:', subscription.id);
    
    try {
        // Update status to canceled instead of deleting
        await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).update({
            status: 'canceled',
            canceledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        console.log('✅ Subscription marked as canceled in Firebase');
    } catch (error) {
        console.error('❌ Error handling subscription deleted:', error);
    }
}

async function handleCustomerDeleted(customer) {
    console.log('📋 Customer deleted:', customer.id);
    
    try {
        // Find and mark all subscriptions for this customer as canceled
        const subscriptionsQuery = await admin.firestore().collection('subscriptions')
            .where('stripeCustomerId', '==', customer.id)
            .get();
        
        const batch = admin.firestore().batch();
        subscriptionsQuery.docs.forEach(doc => {
            batch.update(doc.ref, {
                status: 'canceled',
                updatedAt: new Date().toISOString()
            });
        });
        
        await batch.commit();
        console.log(`✅ Marked ${subscriptionsQuery.docs.length} subscriptions as canceled for customer`);
    } catch (error) {
        console.error('❌ Error handling customer deleted:', error);
    }
}

async function handleInvoicePaymentSucceeded(invoice) {
    console.log('💳 Invoice payment succeeded:', invoice.id);
    
    try {
        if (invoice.subscription) {
            // Update subscription status to active if it was past_due
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
            if (subscription.status === 'active') {
                await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).update({
                    status: 'active',
                    updatedAt: new Date().toISOString()
                });
                console.log('✅ Subscription reactivated after successful payment');
            }
        }
    } catch (error) {
        console.error('❌ Error handling invoice payment succeeded:', error);
    }
}

async function handleInvoicePaymentFailed(invoice) {
    console.log('💳 Invoice payment failed:', invoice.id);
    
    try {
        if (invoice.subscription) {
            // Update subscription status to past_due
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
            if (subscription.status === 'past_due') {
                await admin.firestore().collection('subscriptions').doc(`sub_${subscription.id}`).update({
                    status: 'past_due',
                    updatedAt: new Date().toISOString()
                });
                console.log('⚠️ Subscription marked as past_due after failed payment');
            }
        }
    } catch (error) {
        console.error('❌ Error handling invoice payment failed:', error);
    }
}

// Delete user account endpoint
app.post('/api/delete-account', async (req, res) => {
    try {
        // Wait for Firebase to be initialized
        while (!firebaseInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const { user_id } = req.body;
        
        if (!user_id) {
            return res.status(400).json({ error: 'User ID is required' });
        }
        
        console.log('🗑️ Deleting account for user:', user_id);
        
        // 1. Anonymize financial records (keep for 7 years, but remove PII)
        try {
            await anonymizeFinancialRecords(user_id);
            console.log('✅ Financial records anonymized');
        } catch (financialError) {
            console.error('❌ Failed to anonymize financial records:', financialError);
            // Continue with deletion even if anonymization fails
        }
        
        // 2. Cancel any active subscriptions in Stripe
        try {
            const subscriptionDocs = await admin.firestore()
                .collection('subscriptions')
                .where('userId', '==', user_id)
                .where('status', '==', 'active')
                .get();
            
            for (const doc of subscriptionDocs.docs) {
                const subData = doc.data();
                if (subData.stripeSubscriptionId && !subData.stripeSubscriptionId.includes('mock')) {
                    try {
                        await stripe.subscriptions.cancel(subData.stripeSubscriptionId);
                        console.log('✅ Cancelled Stripe subscription:', subData.stripeSubscriptionId);
                    } catch (stripeError) {
                        console.error('❌ Failed to cancel subscription:', stripeError);
                    }
                }
            }
        } catch (cancelError) {
            console.error('❌ Error cancelling subscriptions:', cancelError);
        }
        
        // 3. Delete user data from Firebase collections
        // NOTE: The iOS app handles Firebase Auth deletion and local file cleanup
        // This endpoint only handles Firestore data deletion
        
        const batch = admin.firestore().batch();
        
        // Delete subscriptions
        const subsSnapshot = await admin.firestore()
            .collection('subscriptions')
            .where('userId', '==', user_id)
            .get();
        subsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        
        // Delete practice sessions
        const sessionsSnapshot = await admin.firestore()
            .collection('practice_sessions')
            .where('userId', '==', user_id)
            .get();
        sessionsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        
        // Delete custom personas
        const personasSnapshot = await admin.firestore()
            .collection('custom_personas')
            .where('userId', '==', user_id)
            .get();
        personasSnapshot.docs.forEach(doc => batch.delete(doc.ref));
        
        // Delete user activity
        const activitySnapshot = await admin.firestore()
            .collection('user_activity')
            .where('userId', '==', user_id)
            .get();
        activitySnapshot.docs.forEach(doc => batch.delete(doc.ref));
        
        // Commit batch deletions
        await batch.commit();
        console.log('✅ Deleted Firestore data for user:', user_id);
        
        // 4. Delete usage tracking data
        try {
            const monthlyUsage = await admin.firestore()
                .collection('usage')
                .doc(user_id)
                .collection('monthly')
                .get();
            
            const usageBatch = admin.firestore().batch();
            monthlyUsage.docs.forEach(doc => usageBatch.delete(doc.ref));
            await usageBatch.commit();
            
            await admin.firestore().collection('usage').doc(user_id).delete();
            console.log('✅ Deleted usage tracking data');
        } catch (usageError) {
            console.error('❌ Error deleting usage data:', usageError);
        }
        
        // 5. Delete user document (last)
        try {
            await admin.firestore().collection('users').doc(user_id).delete();
            console.log('✅ Deleted user document');
        } catch (userError) {
            console.error('❌ Error deleting user document:', userError);
        }
        
        console.log('✅✅✅ Account deletion completed for user:', user_id);
        
        res.json({ 
            success: true, 
            message: 'Account deleted successfully. Anonymized financial records retained for 7 years for tax compliance.' 
        });
        
    } catch (error) {
        console.error('❌ Error deleting account:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Cleanup expired financial records endpoint (for cron jobs)
app.post('/api/cleanup-financial-records', async (req, res) => {
    try {
        // Wait for Firebase to be initialized
        while (!firebaseInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Optional: Add authentication check here to ensure only admins can trigger cleanup
        
        const result = await cleanupExpiredFinancialRecords();
        
        res.json({ 
            success: true, 
            deleted: result.deleted,
            message: `Cleaned up ${result.deleted} expired financial records` 
        });
        
    } catch (error) {
        console.error('❌ Error in cleanup endpoint:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FluencyFlow backend server running on port ${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📧 Email verification: http://localhost:${PORT}/api/send-verification-email`);
    console.log(`💳 Payment intent: http://localhost:${PORT}/api/create-payment-intent`);
    console.log(`📋 Subscription: http://localhost:${PORT}/api/create-subscription`);
    console.log(`🔄 Modify Subscription: http://localhost:${PORT}/api/modify-subscription`);
    console.log(`❌ Cancel Subscription: http://localhost:${PORT}/api/cancel-subscription`);
    console.log(`🔄 Reactivate Subscription: http://localhost:${PORT}/api/reactivate-subscription`);
    console.log(`💳 Setup Intent: http://localhost:${PORT}/api/create-setup-intent`);
    console.log(`🔗 Stripe Webhook: http://localhost:${PORT}/api/stripe-webhook`);
    console.log(`🗑️ Delete Account: http://localhost:${PORT}/api/delete-account`);
    console.log(`🧹 Cleanup Financial Records: http://localhost:${PORT}/api/cleanup-financial-records`);
});
