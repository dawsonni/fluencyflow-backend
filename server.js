require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Email configuration
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER || 'verification@fluencyflow.app',
        pass: process.env.GMAIL_APP_PASSWORD // Your app password
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'FluencyFlow backend is running' });
});

// Send verification email endpoint
app.post('/api/send-verification-email', async (req, res) => {
    try {
        const { parentEmail, childName, verificationToken } = req.body;
        
        console.log('Sending verification email:', { parentEmail, childName, verificationToken });
        
        const verificationURL = `https://fluencyflow.app/verify?token=${verificationToken}`;
        
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

// Get current subscription endpoint
app.get('/api/current-subscription', async (req, res) => {
    try {
        // For now, return a mock active subscription
        // In production, you'd look up the actual subscription from Stripe
        const mockSubscription = {
            id: `sub_${Date.now()}`,
            userId: `user_${Date.now()}`,
            stripeSubscriptionId: `sub_stripe_${Date.now()}`,
            stripeCustomerId: `cus_stripe_${Date.now()}`,
            planType: "premium_individual",
            billingCycle: "monthly",
            status: "active",
            currentPeriodStart: new Date().toISOString(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
            cancelAtPeriodEnd: false,
            isTherapyReferral: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        console.log('Returning current subscription:', mockSubscription.id);
        res.json(mockSubscription);
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
        const mockPortalURL = 'https://billing.stripe.com/p/login/test_customer_portal';
        
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

// Create payment intent endpoint
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, currency, plan_type, billing_cycle, is_therapy_referral } = req.body;
        
        console.log('Creating payment intent:', { amount, currency, plan_type, billing_cycle, is_therapy_referral });
        
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: currency,
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
        const { plan_type, billing_cycle, is_therapy_referral } = req.body;
        
        console.log('Creating subscription:', { plan_type, billing_cycle, is_therapy_referral });
        
        // For now, we'll create a mock subscription response
        // In production, you'd create an actual Stripe subscription
        const mockSubscription = {
            id: `sub_${Date.now()}`,
            userId: `user_${Date.now()}`,
            stripeSubscriptionId: `sub_stripe_${Date.now()}`,
            stripeCustomerId: `cus_stripe_${Date.now()}`,
            planType: plan_type,
            billingCycle: billing_cycle,
            status: 'active',
            currentPeriodStart: new Date().toISOString(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
            cancelAtPeriodEnd: false,
            isTherapyReferral: is_therapy_referral,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        res.json(mockSubscription);
        
    } catch (error) {
        console.error('Error creating subscription:', error);
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
});
