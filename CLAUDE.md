# CLAUDE.md — AI Assistant Guide for SNH Pinball Club Website

---

# 🎯 What This Project Does

This project powers the **Southern New Hampshire Pinball Club website and member system**.

It includes:

- Public website (events, gallery, donate, info)
- Member authentication (signup/login)
- Member profiles
- Subscription-based membership management
- Integration with external tools (Discord, MatchPlay, etc.)

The system is designed to be:

- Low-cost
- Portable
- Simple to maintain
- Extensible over time

---

# 🧭 System Architecture

Frontend (Static Site)
   ↓
Supabase (Auth + Database)
   ↓
Stripe (Subscriptions + Billing)

---

# 🏗️ Tech Stack

- HTML / CSS / Vanilla JavaScript
- GitHub (source control)
- GitHub Pages (primary hosting)
- Supabase (auth + database)
- Stripe (payments)

Optional:
- Netlify (preview deploys only)

---

# 📁 Project Structure

snh-pinball-club-site/
├── CLAUDE.md
├── README.md
├── index.html
├── donate.html
├── members.html
├── login.html
├── signup.html
├── assets/
├── css/
├── js/
│   ├── auth.js
│   ├── api.js
│   └── main.js
└── data/
    └── events.json

---

# 🧠 Core Data Model (Supabase)

## profiles

id UUID PRIMARY KEY REFERENCES auth.users(id)
email TEXT
display_name TEXT
created_at TIMESTAMP

---

## memberships

id UUID PRIMARY KEY
user_id UUID REFERENCES profiles(id)

status TEXT
-- values: active, canceled, past_due, inactive

tier TEXT
-- values: standard

stripe_customer_id TEXT
stripe_subscription_id TEXT

current_period_end TIMESTAMP
created_at TIMESTAMP

---

# 🔐 Authentication Rules

- Use Supabase Auth
- Automatically create profile on signup
- Never store passwords manually

---

# 💳 Subscription Model

- Stripe handles all billing
- No custom billing logic

Flow:
User signs up → Supabase Auth
User subscribes → Stripe Checkout
Webhook → updates membership

---

# 🚨 Critical Rules

DO NOT:
- Build custom billing
- Store payment data
- Overengineer backend

DO:
- Keep logic simple
- Use Supabase for membership state
- Use Stripe for billing

---

# 🧩 Frontend Conventions

HTML:
- Semantic structure

CSS:
- Simple, centralized

JS:
- Vanilla only
- Small modules

---

# 🔄 Development Workflow

1. Edit locally
2. Commit
3. Push
4. Verify
5. Iterate

---

# 🔐 Environment Variables

SUPABASE_URL=
SUPABASE_ANON_KEY=
STRIPE_PUBLIC_KEY=

(optional backend)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

---

# ⚠️ Constraints

- Lightweight
- No unnecessary dependencies
- Fast load times
- Mobile friendly

---

# 🧭 Tone

- Friendly
- Community-driven
- Slightly playful

---

# 🔮 Future Enhancements

- Discord role sync
- MatchPlay integration
- Admin dashboard
- Member directory

---

# 🧠 AI Guidance

- Prefer simple solutions
- Avoid new infrastructure
- Extend existing patterns
