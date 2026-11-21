"""MongoDB: hồ sơ vụ án, thiết bị, người dùng, phiên kéo, audit, gói chứng cứ.
files + chunks (FTS5 bm25, embedding) vẫn ở SQLite data/index.db vì là máy tìm kiếm, Mongo không thay được."""
import os

from pymongo import MongoClient, ReturnDocument

db = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27018/mf"),
                 serverSelectionTimeoutMS=5000).get_default_database()
db.cases.create_index("name", unique=True)
db.devices.create_index([("case_name", 1), ("name", 1)], unique=True)
db.users.create_index("username", unique=True)


def next_id(coll):
    """id số tăng dần như AUTOINCREMENT: giao diện/URL (/api/images/{id}) dùng số, không dùng ObjectId."""
    return db.counters.find_one_and_update({"_id": coll}, {"$inc": {"seq": 1}}, upsert=True,
                                           return_document=ReturnDocument.AFTER)["seq"]


def strip(doc):
    """Bỏ _id của Mongo khỏi dict trả về API."""
    doc.pop("_id", None)
    return doc
