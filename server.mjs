import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const app=express();
const PORT=process.env.PORT||3000;
app.use(express.json({limit:'20mb'}));
app.use(express.static('public'));

const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
const supabase=createClient(process