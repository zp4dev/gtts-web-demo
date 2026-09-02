from fastapi import FastAPI,HTTPException,BackgroundTasks
from fastapi.responses import FileResponse
from gtts import gTTS
import asyncio
import random
import os
import string
app = FastAPI()

def delete_file(file_path: str):
    try:
        os.remove(file_path)
    except OSError:
        pass


@app.post(
    "/audio",
    response_class=FileResponse,
    responses={
        200: {
            "content": {
                "audio/mpeg": {}
            },
            "description": "Generated MP3 audio",
        }
    },
)

async def generate_audio(text:str,lang : str ="en",background_task: BackgroundTasks=None):
    
    word = text.split()
    if len(word) > 150:
        raise HTTPException (
            status_code=400,
            detail="The input length must be under 150 character"
        )
    filepath = 'cache'
    filename = ''.join(random.choices(string.ascii_letters + string.digits,k=12)) + '.mp3'
    file_path = os.path.join(filepath,filename)
    speech = gTTS(text,lang=lang)
    await asyncio.to_thread (
        speech.save,
        file_path,
    )
    try:
        speech.save(filepath + '/' + filename)
    except Exception as e:
        raise HTTPException (
            status_code=400,
            detail='Somethings went wrong,please try again=)'
        )
    background_task.add_task(delete_file,file_path)
    return FileResponse (
        path=file_path,
        media_type='audio/mpeg',
        filename=filename,
    )