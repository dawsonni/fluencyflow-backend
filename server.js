require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const nodemailer = require('nodemailer');

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
function getProductId(planType) {
    const productMapping = {
        'starter': 'prod_T7bU5ypppEYoVr',
        'professional': 'prod_T7bU5ypppEYoVr', 
        'premium': 'prod_T7bU5ypppEYoVr'
    };
    return productMapping[planType] || 'prod_T7bU5ypppEYoVr';
}

// Initialize Stripe with Key Vault
let stripe;
let stripeInitialized = false;

async function initializeStripe() {
    try {
        const stripeSecretKey = await getSecret('stripe-secret-key-test');
        console.log('🔍 Retrieved Stripe key from Key Vault:', stripeSecretKey.substring(0, 20) + '...');
        stripe = require('stripe')(stripeSecretKey);
        stripeInitialized = true;
        console.log('✅ Stripe initialized with Key Vault');
    } catch (error) {
        console.error('❌ Failed to initialize Stripe:', error);
        stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        stripeInitialized = true;
    }
}

// Initialize Stripe
initializeStripe();

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
app.use(express.json());
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
        // Get user ID from request headers or query params
        const userId = req.headers['user-id'] || req.query.userId;
        
        if (!userId) {
            console.log('No user ID provided - returning no subscription');
            return res.json(null); // No subscription for users without ID
        }
        
        console.log('Looking up subscription for user:', userId);
        
        // Try to find customer in Stripe by email or metadata
        // For now, we'll check if there are any active subscriptions
        // In a real implementation, you'd store the Stripe customer ID with the user
        
        try {
            // List all customers and find one that matches our user
            const customers = await stripe.customers.list({ limit: 100 });
            console.log(`Found ${customers.data.length} customers in Stripe`);
            
            let customer = null;
            
            // Look for customer with matching metadata or email
            for (const c of customers.data) {
                console.log(`Checking customer ${c.id}:`, {
                    email: c.email,
                    metadata: c.metadata,
                    hasUserId: c.metadata && c.metadata.userId,
                    userIdMatch: c.metadata && c.metadata.userId === userId
                });
                
                if (c.metadata && c.metadata.userId === userId) {
                    customer = c;
                    console.log('Found matching customer:', c.id);
                    break;
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
                
                // Fallback: Check if customer has mock subscription in metadata
                if (customer.metadata && customer.metadata.hasActiveSubscription === 'true') {
                    console.log('Found mock subscription in customer metadata as fallback');
                    
                    const subscription = {
                        id: customer.metadata.subscriptionId,
                        userId: userId,
                        stripeSubscriptionId: customer.metadata.subscriptionId,
                        stripeCustomerId: customer.id,
                        planType: customer.metadata.planType || "professional",
                        billingCycle: customer.metadata.billingCycle || "monthly",
                        status: customer.metadata.subscriptionStatus || "active",
                        currentPeriodStart: new Date().toISOString(),
                        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
                        cancelAtPeriodEnd: false,
                        isTherapyReferral: customer.metadata.isTherapyReferral === 'true' || false,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };
                    
                    console.log('Returning mock subscription:', subscription.id);
                    return res.json(subscription);
                }
                
                return res.json(null); // No active subscription
            }
            
            const stripeSubscription = subscriptions.data[0];
            console.log('Found real Stripe subscription:', stripeSubscription.id);
            
            // Convert Stripe subscription to our format
            const subscription = {
                id: `sub_${stripeSubscription.id}`,
                userId: userId,
                stripeSubscriptionId: stripeSubscription.id,
                stripeCustomerId: customer.id,
                planType: stripeSubscription.metadata?.planType || "professional",
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
        // For now, return a mock customer portal URL
        // In production, you'd create a Stripe customer portal session
        const mockPortalURL = 'https://stripe.com';
        
        console.log('Creating customer portal session');
        res.json({ url: mockPortalURL });
    } catch (error) {
        console.error('Error creating customer portal session:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Cancel subscription endpoint
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        const { subscription_id } = req.body;
        
        console.log('Cancelling subscription:', subscription_id);
        
        // Cancel the subscription in Stripe
        const subscription = await stripe.subscriptions.cancel(subscription_id);
        
        console.log('Subscription cancelled:', subscription.id);
        res.json({ 
            success: true, 
            subscription: {
                id: subscription.id,
                status: subscription.status,
                canceled_at: subscription.canceled_at
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

// Create payment intent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        // Wait for Stripe to be initialized
        while (!stripeInitialized) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const { amount, currency, plan_type, billing_cycle, is_therapy_referral, user_email } = req.body;
        
        console.log('Creating payment intent:', { amount, currency, plan_type, billing_cycle, is_therapy_referral, user_email });
        
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
            amount: amount,
            currency: currency,
            customer: customer?.id,
            setup_future_usage: 'off_session', // This will save the payment method for future use
            metadata: {
                plan_type,
                billing_cycle,
                is_therapy_referral: is_therapy_referral.toString()
            }
        });
        
        res.json({
            id: paymentIntent.id,
            client_secret: paymentIntent.client_secret,
            amount: paymentIntent.amount,
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
        
        const { plan_type, billing_cycle, is_therapy_referral, user_id, user_email, payment_intent_id, price_id, product_id } = req.body;
        
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
        
        // Create subscription in Stripe
        try {
            // Use the price_id from the request body (sent from iOS app)
            let priceId = price_id;
            
            // Fallback to hardcoded mapping if price_id not provided (for backward compatibility)
            if (!priceId) {
                if (plan_type === 'starter' && billing_cycle === 'monthly') {
                    priceId = 'price_1SBMCh2QVCQwj6xKAxuwKisC';
                } else if (plan_type === 'starter' && billing_cycle === 'yearly') {
                    priceId = 'price_1SBMGX2QVCQwj6xKb9suTwhR';
                } else if (plan_type === 'professional' && billing_cycle === 'monthly') {
                    priceId = 'price_1SBMHE2QVCQwj6xKgYNPRtB6';
                } else if (plan_type === 'professional' && billing_cycle === 'yearly') {
                    priceId = 'price_1SBMHU2QVCQwj6xKk4AtbNBd';
                } else if (plan_type === 'premium' && billing_cycle === 'monthly') {
                    priceId = 'price_1SBMHv2QVCQwj6xKON7BWqbX';
                } else if (plan_type === 'premium' && billing_cycle === 'yearly') {
                    priceId = 'price_1SBMI52QVCQwj6xKlJR975L0';
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
            
            const stripeSubscription = await stripe.subscriptions.create({
                customer: customer.id,
                items: [{
                    price: priceId,
                }],
                metadata: {
                    userId: user_id,
                    planType: plan_type,
                    billingCycle: billing_cycle,
                    isTherapyReferral: is_therapy_referral.toString()
                }
            });
            
            console.log('Stripe subscription created successfully:', stripeSubscription.id);
            console.log('Subscription status:', stripeSubscription.status);
            
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
        
        const { plan_type, billing_cycle, user_id, user_email, price_id, product_id } = req.body;
        
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
            const updatedSubscription = await stripe.subscriptions.update(existingSubscription.id, {
                items: [{
                    id: existingSubscription.items.data[0].id,
                    price: newPriceId,
                }],
                proration_behavior: 'create_prorations', // This handles proration automatically
                metadata: {
                    plan_type: plan_type,
                    billing_cycle: billing_cycle,
                    product_id: product_id || getProductId(plan_type),
                    is_therapy_referral: 'false',
                    modified_at: new Date().toISOString()
                }
            });
            
            console.log('Subscription updated successfully:', updatedSubscription.id);
            
            // Update customer metadata
            await stripe.customers.update(customer.id, {
                metadata: {
                    ...customer.metadata,
                    plan_type: plan_type,
                    billing_cycle: billing_cycle,
                    last_modified: new Date().toISOString()
                }
            });
            
            // Save to database
            const subscriptionData = {
                id: updatedSubscription.id,
                userId: user_id,
                planType: plan_type,
                billingCycle: billing_cycle,
                status: updatedSubscription.status,
                stripeSubscriptionId: updatedSubscription.id,
                stripeCustomerId: customer.id,
                currentPeriodStart: new Date(updatedSubscription.current_period_start * 1000).toISOString(),
                currentPeriodEnd: new Date(updatedSubscription.current_period_end * 1000).toISOString(),
                cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
                createdAt: new Date(updatedSubscription.created * 1000).toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            // Update subscription in database
            const subscriptionRef = db.collection('subscriptions').doc(updatedSubscription.id);
            await subscriptionRef.set(subscriptionData, { merge: true });
            
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FluencyFlow backend server running on port ${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📧 Email verification: http://localhost:${PORT}/api/send-verification-email`);
    console.log(`💳 Payment intent: http://localhost:${PORT}/api/create-payment-intent`);
    console.log(`📋 Subscription: http://localhost:${PORT}/api/create-subscription`);
    console.log(`🔄 Modify Subscription: http://localhost:${PORT}/api/modify-subscription`);
});
