"""MedASR transcription service for Cloud Run GPU."""

import io
import os
import tempfile
import torch
import soundfile as sf
import librosa
from fastapi import FastAPI, UploadFile, File, Header, HTTPException
from fastapi.responses import JSONResponse
import uvicorn
from transformers import pipeline

app = FastAPI(title="MedASR Transcription Service")

# Global model reference
asr_pipeline = None

# Simple API key auth
API_KEY = os.environ.get("API_KEY", "")


def get_pipeline():
    """Lazy-load the MedASR model."""
    global asr_pipeline
    if asr_pipeline is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading MedASR model on {device}...")
        asr_pipeline = pipeline(
            "automatic-speech-recognition",
            model="google/medasr",
            device=device,
            trust_remote_code=True,
            # Process in 20-second chunks with 2-second overlap as recommended
            chunk_length_s=20,
            stride_length_s=2,
        )
        print("MedASR model loaded successfully.")
    return asr_pipeline


@app.get("/health")
async def health():
    return {"status": "ok", "model": "google/medasr", "gpu": torch.cuda.is_available()}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    authorization: str = Header(default=""),
):
    """Transcribe audio using MedASR.

    Accepts any audio format (webm, wav, mp3, etc).
    Returns JSON with 'text' field containing the transcription.
    """
    # Auth check
    if API_KEY:
        token = authorization.replace("Bearer ", "") if authorization.startswith("Bearer ") else authorization
        if token != API_KEY:
            raise HTTPException(status_code=401, detail="Invalid API key")

    try:
        # Read uploaded audio
        audio_bytes = await file.read()

        # Save to temp file for librosa to handle format conversion
        suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            # Load and resample to 16kHz mono (MedASR requirement)
            audio, sr = librosa.load(tmp_path, sr=16000, mono=True)
        finally:
            os.unlink(tmp_path)

        # Run MedASR inference
        pipe = get_pipeline()
        result = pipe({"array": audio, "sampling_rate": 16000})

        transcript = result.get("text", "")

        return JSONResponse(content={"text": transcript})

    except Exception as e:
        print(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    # Pre-load model on startup
    get_pipeline()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
