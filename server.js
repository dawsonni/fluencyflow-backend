require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Stripe backend is running' });
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
    console.log(`🚀 Stripe backend server running on port ${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/api/health`);
    console.log(`💳 Payment intent: http://localhost:${PORT}/api/create-payment-intent`);
    console.log(`📋 Subscription: http://localhost:${PORT}/api/create-subscription`);
});
