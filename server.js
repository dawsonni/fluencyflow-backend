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
                        planType: customer.metadata.planType || "premium_individual",
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
                planType: stripeSubscription.metadata?.planType || "premium_individual",
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
        const { plan_type, billing_cycle, is_therapy_referral, user_id, user_email, payment_intent_id } = req.body;
        
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
            // Map plan type and billing cycle to Stripe price ID
            let priceId;
            if (plan_type === 'premium_individual' && billing_cycle === 'monthly') {
                priceId = 'price_1RxXss2QVCQwj6xKh62b5DpQ'; // Monthly
            } else if (plan_type === 'premium_individual' && billing_cycle === 'yearly') {
                priceId = 'price_1RxXss2QVCQwj6xKHri3JRk0'; // Yearly
            } else {
                throw new Error(`Unsupported plan: ${plan_type} ${billing_cycle}`);
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FluencyFlow backend server running on port ${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/api/health`);
    console.log(`📧 Email verification: http://localhost:${PORT}/api/send-verification-email`);
    console.log(`💳 Payment intent: http://localhost:${PORT}/api/create-payment-intent`);
    console.log(`📋 Subscription: http://localhost:${PORT}/api/create-subscription`);
});
