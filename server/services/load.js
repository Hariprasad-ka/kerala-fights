const fs = require('fs');
const models = require('../models');
const distrctMap = require('../config/data').districtMap;
const moment = require('moment');
const request =require('request');
const cheerio = require('cheerio');

const Sequelize = require('sequelize');
const sequelize = new Sequelize(require('../config/config'));


function getContent(url)  { 
    return new Promise((resolve,reject) => { 
        request({
            url: url,
            time: true
        }, function (error, response, body) {
            if (error){
                return reject(err);
            }
            resolve(body); 
        }); 
    });
}

async function loadData(offset=0){

    const content  = await getContent(`https://www.keralarescue.in/data/?offset=${offset}`);
    const parsed = JSON.parse(content); 
    // console.log(parsed);
    const source = 'www.keralarescue.in';
    let maxId = 0;
    if (parsed.data.length == 0){
        console.log('Processin Complete');
        return;
    }
    for(var idx = 0;idx < parsed.data.length;idx++){
        const data = parsed.data[idx];

        let row = await models.HelpRequest.findOne({
            where:{
                remoteId:data.id,
                source:source,
            }
        });
        if (maxId < data.id){
            maxId = data.id;
        }

        const cords = data.latlng.split(",");
        let geoJson = null;
        let location = null;

        if (!isNaN(cords[0]) && !isNaN(cords[1])  && cords.length == 2 ){
            geoJson =  {
                type:'Point',
                coordinates:cords
            };
            location = {
                lat:parseFloat(cords[0]),
                lon:parseFloat(cords[1])
            };
        }

        const tags = [];
        if (data.needwater){
            tags.push('Need Water');
        }

        if(data.needfood){
            tags.push("Need Foood");
        }

        if(data.needcloth){
            tags.push("Need Cloth");
        }

        if(data.needmed){
            tags.push("Need Medicine");
        }

        if (data.needtoilet){
            tags.push("Need Tolilery");
        }

        if (data.is_request_for_others){
            tags.push("Requesting for someone else");
            geoJson = null;
            location = null;
        }

        if (data.needkit_util){
            tags.push("Need Kit");
        }

        if(data.needrescue){
            tags.push("Needs Evacuation");
        }
        let json = {}
        if (!row){
            row =  await models.HelpRequest.create({
                remoteId: data.id,
                source:source,
                type:'rescue_request'
            });
        } else {
            json = row.json;
        }
 
        row.remoteId=  data.id;
        row.source  = source;
        row.type = 'rescue_request';
        row.district = distrctMap[data.district.substring(0,255)];
        row.location = data.location.substring(0,255);
        row.personName = data.requestee.substring(0,255);
        row.phoneNumber = data.requestee_phone;
        row.latLng = geoJson;
        row.status = data.status.toUpperCase();
        row.information =  data.location+'\n'+ data.needothers;
        row.createdAt = moment(data.dateadded);
        row.json =  Object.assign(json, {
            location:location,
            info :data,
            tags :tags
        });
        const updated =  await row.save();
        console.log("Adding / updating   Row",updated.id)
    }
    console.log('Done total',maxId);
    setTimeout(function(){
        loadData(maxId);
    },1000)
}

async function handleContent(resp,page){ 
    // console.log(resp);
    var $ = cheerio.load(resp);  
    const valList = [];

    const rows = [
        'district',
        'location',
        'requestee', 
        'phone_number',
        'date_time'
    ];

    $("table.table tr").each((idx,elem)=>{ 
        const tds = $(elem).find('td'); 
        if (tds.length){
            const obj = {};
            tds.each((idx,elem)=>{
                const key = rows[idx];
                if (!key){
                    return;
                }
                obj[key] = $(elem).text();
            });
            
            const parts = obj['district'].split('-');
            obj['district'] = parts[0].trim();
            obj['date_time'] = obj['date_time']
                .replace('a.m','am')
                .replace('p.m','pm'); 
            obj['date_time'] = moment(obj['date_time']+" +5:30",'MMM. DD, YYYY, hh:mm a ZZ').toDate();

            const link = $(elem).find('a.btn-success').attr('href');
            const parts2 = link.split('/');
            obj['id'] = parts2[2];
            valList.push(obj);
        }
    }); 

    for(var idx = 0;idx < valList.length;idx++){
        var data = valList[idx];
        const exists = await models.HelpRequest.findOne({
            where:{
                source:'www.keralarescue.in',
                remoteId:data['id'],
            }
        });
        if (exists){
            continue;
        }
        const parent = await models.HelpRequest.findOne({
            where :{
                phoneNumber:data['phone_number']
            }
        });
        const newObj = {
            source:'www.keralarescue.in',
            remoteId:data['id'],
            district:data['district'],
            personName:data['requestee'],
            phoneNumber:data['phone_number'],
            type:'help_request',
            parentId:parent?parent.id:null,
            address:data['location'],
            json:{
                tags:[],
            }
        };

        if (new Date().getTime() > data['date_time'].getTime()){
            newObj.createdAt  = data['date_time'];
        }
        const row = await models.HelpRequest.create(newObj);
        console.log("Created new item",row.id);
    }

    loadFromHTML(page-1)
}

async function deDupe(){
    const list = await sequelize.query(`SELECT 
        phone_number,
        count(*) as total_requests ,
        min(created_at) as min_created , 
        min(remote_id) as min_remote
    FROM 
        help_requests  
    GROUP BY 
        phone_number 
    HAVING
        count(*) > 1
    ORDER BY
        total_requests DESC 
    LIMIT 100000`,{  
        plain: false,
        raw: false,
        type: Sequelize.QueryTypes.SELECT
    });

    for(var idx =0;idx < list.length;idx++){
        const data = list[idx]; 
        const row = await models.HelpRequest.findOne({
            where : {
                remoteId: data.min_remote
            }
        });
        console.log(data.phone_number,row.id);
        const qry = `UPDATE help_requests 
        SET parent_id=${row.id} WHERE phone_number = '${data.phone_number}';`;
        console.log(qry);
        const res = await sequelize.query(qry,{
            plain: false,
            raw: false,
        });
        row.parent_id = null;
        row.json.duplicateCount = data.total_requests;
        console.log(res);
        const saved = await row.save();
     }
     console.log('Completed updateing duplicates');
     process.exit();
}

function loadFromHTML(page = 1){
    if (page < 1){
        process.exit();
        return;
    } 
    console.log('Loading from page:',page);
    getContent(`https://www.keralarescue.in/requests/?page=${page}&district=`)
    .then(resp=>{
        handleContent(resp,page);
    });
}
if (process.argv.length > 2 ){
    option = process.argv[2];
    if (option == 'data'){
       loadData(process.argv[2]);
    } else if (option == 'html'){
        loadFromHTML(process.argv[3]);
    } else if (option == 'dedup'){
        deDupe();
    }
} else {
    console.log('Missing options [data  | html endpage | sheet]');
}
